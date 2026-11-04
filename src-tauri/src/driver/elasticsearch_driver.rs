//! Elasticsearch 驱动（非关系型驱动族的第三个引擎）。
//!
//! ES 没有「库 / 表」，只有索引（index）→ 文档（document），而且交互就是 REST + JSON，
//! 所以这里直接用项目里已有的 reqwest 打 REST，不再引官方 ES client（更轻、响应原样可见）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::DbConnection;
use crate::domain::{ConnectionConfig, EsClusterInfo, EsSearchResult};
use crate::error::{AppError, AppResult};

/// 一条 ES 连接：一个复用连接池的 client + base url + 可选 Basic Auth。
pub struct EsConn {
    client: reqwest::Client,
    base: String,
    auth: Option<(String, String)>,
}

pub struct ElasticsearchDriver;

fn base_url(config: &ConnectionConfig, host: &str, port: u16) -> String {
    // ssl_mode 留空 / disabled / preferred 都当 http；显式要求校验即 https
    let scheme = match config.ssl_mode.as_deref() {
        Some("disabled") | Some("preferred") | None => "http",
        _ => "https",
    };
    format!("{scheme}://{host}:{port}")
}

impl EsConn {
    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self.client.request(method, format!("{}{}", self.base, path));
        if let Some((user, pass)) = &self.auth {
            rb = rb.basic_auth(user, Some(pass));
        }
        rb
    }

    /// 发请求并把响应当 JSON 解析；非 2xx 时尽量抽出 ES 的 reason。
    async fn send(&self, rb: reqwest::RequestBuilder) -> AppResult<serde_json::Value> {
        let resp = rb
            .send()
            .await
            .map_err(|e| AppError::Message(format!("请求 Elasticsearch 失败：{e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Message(format!("读取 Elasticsearch 响应失败：{e}")))?;
        let parsed: Option<serde_json::Value> = serde_json::from_str(&text).ok();
        if !status.is_success() {
            let msg = parsed
                .as_ref()
                .and_then(es_error)
                .unwrap_or_else(|| text.chars().take(400).collect());
            return Err(AppError::Message(format!("ES {}：{msg}", status.as_u16())));
        }
        Ok(parsed.unwrap_or(serde_json::Value::Null))
    }
}

/// 从 ES 的错误响应里抠出可读的一句话。
fn es_error(v: &serde_json::Value) -> Option<String> {
    if let Some(reason) = v.pointer("/error/root_cause/0/reason").and_then(|x| x.as_str()) {
        return Some(reason.to_string());
    }
    if let Some(reason) = v.pointer("/error/reason").and_then(|x| x.as_str()) {
        return Some(reason.to_string());
    }
    v.pointer("/error/type").and_then(|x| x.as_str()).map(str::to_string)
}

/// mapping 里递归摊平成 `a.b.c` 字段名。
fn flatten_properties(props: &serde_json::Value, prefix: &str, out: &mut Vec<String>) {
    let Some(map) = props.as_object() else { return };
    for (name, body) in map {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        match body.get("properties") {
            Some(sub) if sub.is_object() => flatten_properties(sub, &path, out),
            _ => out.push(path),
        }
    }
}

impl ElasticsearchDriver {
    pub async fn connect(
        config: &ConnectionConfig,
        password: &str,
        ssh_password: Option<String>,
    ) -> AppResult<DbConnection> {
        let (host, port) = if config.ssh_enabled {
            let tunnel =
                crate::ssh_tunnel::start_tunnel(config, &config.host, config.port, ssh_password).await?;
            let port = tunnel.local_port;
            crate::ssh_tunnel::register(&config.id, tunnel);
            ("127.0.0.1".to_string(), port)
        } else {
            (config.host.clone(), config.port)
        };
        let base = base_url(config, &host, port);
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
        // 自签证书的集群：只有走了 https 且没配 CA 时才放宽校验
        if base.starts_with("https") && config.ssl_ca.is_none() {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder
            .build()
            .map_err(|e| AppError::Message(format!("创建 HTTP 客户端失败：{e}")))?;
        let auth = if config.username.trim().is_empty() {
            None
        } else {
            Some((config.username.trim().to_string(), password.to_string()))
        };
        let conn = EsConn { client, base, auth };
        // 先探一下，让「测试连接 / 打开」能立刻报错
        conn.send(conn.req(reqwest::Method::GET, "/")).await?;
        Ok(DbConnection::Elasticsearch(Arc::new(conn)))
    }

    pub async fn cluster_info(conn: &DbConnection) -> AppResult<EsClusterInfo> {
        let c = conn.as_es();
        let v = c.send(c.req(reqwest::Method::GET, "/")).await?;
        Ok(EsClusterInfo {
            name: v
                .get("cluster_name")
                .and_then(|x| x.as_str())
                .unwrap_or("elasticsearch")
                .to_string(),
            version: v
                .pointer("/version/number")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        })
    }

    /// ES 没有库的概念，这里把集群名当作「库」返回，前端只用来占位。
    pub async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>> {
        let info = Self::cluster_info(conn).await?;
        Ok(vec![info.name])
    }

    pub async fn list_indices(conn: &DbConnection) -> AppResult<Vec<String>> {
        let c = conn.as_es();
        let v = c
            .send(c.req(reqwest::Method::GET, "/_cat/indices?format=json&h=index&s=index"))
            .await?;
        let mut names: Vec<String> = v
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| o.get("index").and_then(|x| x.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        Ok(names)
    }

    /// 索引的字段名（mapping 递归摊平成 a.b.c）。
    pub async fn fields(conn: &DbConnection, index: &str) -> AppResult<Vec<String>> {
        let c = conn.as_es();
        let v = c
            .send(c.req(reqwest::Method::GET, &format!("/{index}/_mapping")))
            .await?;
        let mut out: Vec<String> = Vec::new();
        if let Some(obj) = v.as_object() {
            for body in obj.values() {
                if let Some(props) = body.pointer("/mappings/properties") {
                    flatten_properties(props, "", &mut out);
                }
            }
        }
        out.sort();
        out.dedup();
        Ok(out)
    }

    /// 新建索引：body 可选（settings / mappings），空就是默认配置。
    pub async fn create_index(conn: &DbConnection, index: &str, body: &str) -> AppResult<serde_json::Value> {
        let c = conn.as_es();
        let name = index.trim();
        if name.is_empty() {
            return Err(AppError::Message("索引名不能为空".to_string()));
        }
        let doc: serde_json::Value = if body.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(body)
                .map_err(|e| AppError::Message(format!("索引定义不是合法 JSON：{e}")))?
        };
        c.send(c.req(reqwest::Method::PUT, &format!("/{name}")).json(&doc))
            .await
    }

    pub async fn delete_index(conn: &DbConnection, index: &str) -> AppResult<serde_json::Value> {
        let c = conn.as_es();
        c.send(c.req(reqwest::Method::DELETE, &format!("/{index}"))).await
    }

    pub async fn search(conn: &DbConnection, index: &str, body: &str) -> AppResult<EsSearchResult> {
        let c = conn.as_es();
        let doc: serde_json::Value = if body.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(body)
                .map_err(|e| AppError::Message(format!("查询体不是合法 JSON：{e}")))?
        };
        let start = Instant::now();
        let v = c
            .send(c.req(reqwest::Method::POST, &format!("/{index}/_search")).json(&doc))
            .await?;
        let total = v
            .pointer("/hits/total/value")
            .and_then(|x| x.as_u64())
            .or_else(|| v.pointer("/hits/total").and_then(|x| x.as_u64()))
            .unwrap_or(0);
        let took = v.get("took").and_then(|x| x.as_u64()).unwrap_or(0);
        let documents = v
            .pointer("/hits/hits")
            .and_then(|h| h.as_array())
            .map(|hits| {
                hits.iter()
                    .map(|h| {
                        let mut row = serde_json::Map::new();
                        if let Some(src) = h.get("_source").and_then(|s| s.as_object()) {
                            for (k, val) in src {
                                row.insert(k.clone(), val.clone());
                            }
                        }
                        for meta in ["_id", "_index", "_score"] {
                            if let Some(val) = h.get(meta) {
                                row.insert(meta.to_string(), val.clone());
                            }
                        }
                        serde_json::Value::Object(row)
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(EsSearchResult {
            documents,
            total,
            took_ms: took,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    /// 写文档：给了 id 就 PUT（覆盖），没给就 POST 自动生成 id。
    pub async fn index_doc(
        conn: &DbConnection,
        index: &str,
        id: Option<&str>,
        document: &str,
    ) -> AppResult<serde_json::Value> {
        let c = conn.as_es();
        let doc: serde_json::Value = serde_json::from_str(document)
            .map_err(|e| AppError::Message(format!("文档不是合法 JSON：{e}")))?;
        let path = match id.filter(|s| !s.trim().is_empty()) {
            Some(id) => format!("/{index}/_doc/{id}"),
            None => format!("/{index}/_doc"),
        };
        let method = if id.map(|s| !s.trim().is_empty()).unwrap_or(false) {
            reqwest::Method::PUT
        } else {
            reqwest::Method::POST
        };
        // ES 近实时：不带 refresh 的话，写完立刻搜索还是 0 条。
        // wait_for 会等下一次 refresh 再返回，保证返回后就能查到。
        c.send(c.req(method, &format!("{path}?refresh=wait_for")).json(&doc))
            .await
    }

    pub async fn delete_doc(conn: &DbConnection, index: &str, id: &str) -> AppResult<serde_json::Value> {
        let c = conn.as_es();
        c.send(c.req(reqwest::Method::DELETE, &format!("/{index}/_doc/{id}")))
            .await
    }

    /// 通用 REST：给「_cat / _cluster / _aliases」这类命令留一个口子。
    pub async fn request(
        conn: &DbConnection,
        method: &str,
        path: &str,
        body: &str,
    ) -> AppResult<serde_json::Value> {
        let c = conn.as_es();
        let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
            .map_err(|_| AppError::Message(format!("不支持的 HTTP 方法：{method}")))?;
        let path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };
        let rb = c.req(m, &path);
        if body.trim().is_empty() {
            c.send(rb).await
        } else {
            let doc: serde_json::Value = serde_json::from_str(body)
                .map_err(|e| AppError::Message(format!("请求体不是合法 JSON：{e}")))?;
            c.send(rb.json(&doc)).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(ssl: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "es".into(),
            name: "es".into(),
            host: "127.0.0.1".into(),
            port: 9200,
            username: "elastic".into(),
            database: None,
            flavor: crate::domain::DbFlavor::Elasticsearch,
            file_path: None,
            ssl_mode: ssl.map(str::to_string),
            ssl_ca: None,
            ssl_cert: None,
            ssl_key: None,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_user: String::new(),
            ssh_auth_method: None,
            ssh_private_key_path: None,
            oracle_conn_type: None,
            oracle_role: None,
        }
    }

    #[test]
    fn picks_scheme_from_ssl_mode() {
        assert_eq!(base_url(&config(None), "h", 9200), "http://h:9200");
        assert_eq!(base_url(&config(Some("disabled")), "h", 9200), "http://h:9200");
        assert_eq!(base_url(&config(Some("required")), "h", 9200), "https://h:9200");
    }

    #[test]
    fn flattens_nested_mapping_properties() {
        let props = serde_json::json!({
            "name": { "type": "text" },
            "user": { "properties": { "id": { "type": "keyword" }, "age": { "type": "long" } } }
        });
        let mut out = Vec::new();
        flatten_properties(&props, "", &mut out);
        out.sort();
        assert_eq!(out, vec!["name", "user.age", "user.id"]);
    }

    #[test]
    fn extracts_error_reason() {
        let v = serde_json::json!({ "error": { "root_cause": [{ "reason": "index_not_found" }] } });
        assert_eq!(es_error(&v).as_deref(), Some("index_not_found"));
    }
}
