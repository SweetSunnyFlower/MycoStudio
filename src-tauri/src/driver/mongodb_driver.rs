//! MongoDB 驱动（非关系型驱动族的第二个引擎）。
//!
//! MongoDB 是文档库：库 → 集合 → 文档。文档 schema-less，所以这里不套「表/字段」那套，
//! 而是把文档直接转成宽松扩展 JSON 给前端渲染成表格。

use super::DbConnection;
use crate::domain::{ConnectionConfig, MongoQueryResult};
use crate::error::{AppError, AppResult};
use futures::TryStreamExt;

pub struct MongoDbDriver;

/// URI userinfo 里的特殊字符要百分号转义（避免破坏连接串）。
fn escape_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn connect_uri(config: &ConnectionConfig, password: &str, host: &str, port: u16) -> String {
    let mut uri = String::from("mongodb://");
    let username = config.username.trim();
    if !username.is_empty() || !password.is_empty() {
        if !username.is_empty() {
            uri.push_str(&escape_userinfo(username));
        }
        if !password.is_empty() {
            uri.push(':');
            uri.push_str(&escape_userinfo(password));
        }
        uri.push('@');
    }
    uri.push_str(host);
    uri.push(':');
    uri.push_str(&port.to_string());
    // 配置里的 database 对 Mongo 来说就是「默认库 / 认证库」，写进 URI 的 path
    if let Some(db) = config.database.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        uri.push('/');
        uri.push_str(&escape_userinfo(db));
    }
    uri
}

impl MongoDbDriver {
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
        let uri = connect_uri(config, password, &host, port);
        let client = mongodb::Client::with_uri_str(&uri)
            .await
            .map_err(|e| AppError::Message(format!("MongoDB 连接失败：{e}")))?;
        // 先 ping 一下，让「测试连接 / 打开」能立刻报错而不是懒加载
        client
            .database("admin")
            .run_command(mongodb::bson::doc! { "ping": 1 })
            .await
            .map_err(|e| AppError::Message(format!("MongoDB 连接失败：{e}")))?;
        Ok(DbConnection::MongoDb(client))
    }

    pub async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>> {
        let client = conn.as_mongo();
        let mut names = client
            .list_database_names()
            .await
            .map_err(|e| AppError::Message(format!("列出数据库失败：{e}")))?;
        names.sort();
        Ok(names)
    }

    pub async fn list_collections(conn: &DbConnection, database: &str) -> AppResult<Vec<String>> {
        let client = conn.as_mongo();
        let mut names = client
            .database(database)
            .list_collection_names()
            .await
            .map_err(|e| AppError::Message(format!("列出集合失败：{e}")))?;
        names.sort();
        Ok(names)
    }

    /// JSON → BSON。这里比 `bson::to_document` 多认一层「宽松扩展 JSON」标记
    /// （ObjectId 的 `{"$oid":"..."}`、日期、长整数等），这样把文档回传编辑/删除时
    /// `_id` 不会从 ObjectId 悄悄变成普通字符串。
    fn json_to_bson(v: &serde_json::Value) -> mongodb::bson::Bson {
        use mongodb::bson::{Bson, Document};
        match v {
            serde_json::Value::Null => Bson::Null,
            serde_json::Value::Bool(b) => Bson::Boolean(*b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Bson::Int64(i)
                } else if let Some(u) = n.as_u64() {
                    Bson::Int64(u as i64)
                } else if let Some(f) = n.as_f64() {
                    Bson::Double(f)
                } else {
                    Bson::Int64(0)
                }
            }
            serde_json::Value::String(s) => Bson::String(s.clone()),
            serde_json::Value::Array(items) => {
                Bson::Array(items.iter().map(Self::json_to_bson).collect())
            }
            serde_json::Value::Object(map) => {
                // 扩展 JSON 的单键标记
                if map.len() == 1 {
                    if let Some(hex) = map.get("$oid").and_then(|v| v.as_str()) {
                        if let Ok(id) = mongodb::bson::oid::ObjectId::parse_str(hex) {
                            return Bson::ObjectId(id);
                        }
                    }
                    if let Some(date) = map.get("$date") {
                        if let Some(ms) = date
                            .get("$numberLong")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<i64>().ok())
                        {
                            return Bson::DateTime(mongodb::bson::DateTime::from_millis(ms));
                        }
                        if let Some(iso) = date.as_str() {
                            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) {
                                return Bson::DateTime(mongodb::bson::DateTime::from_millis(
                                    dt.timestamp_millis(),
                                ));
                            }
                        }
                    }
                    if let Some(n) = map
                        .get("$numberLong")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<i64>().ok())
                    {
                        return Bson::Int64(n);
                    }
                    if let Some(n) = map
                        .get("$numberInt")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<i32>().ok())
                    {
                        return Bson::Int32(n);
                    }
                    if let Some(n) = map
                        .get("$numberDouble")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<f64>().ok())
                    {
                        return Bson::Double(n);
                    }
                }
                let mut doc = Document::new();
                for (k, val) in map {
                    doc.insert(k.clone(), Self::json_to_bson(val));
                }
                Bson::Document(doc)
            }
        }
    }

    fn parse_document(json: &str) -> AppResult<mongodb::bson::Document> {
        let value: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| AppError::Message(format!("不是合法的 JSON：{e}")))?;
        match Self::json_to_bson(&value) {
            mongodb::bson::Bson::Document(d) => Ok(d),
            _ => Err(AppError::Message("JSON 顶层必须是一个对象".to_string())),
        }
    }

    fn doc_to_json(doc: &mongodb::bson::Document) -> serde_json::Value {
        serde_json::to_value(doc).unwrap_or(serde_json::Value::Null)
    }

    pub async fn find(
        conn: &DbConnection,
        database: &str,
        collection: &str,
        filter: &str,
        sort: &str,
        skip: u64,
        limit: u64,
    ) -> AppResult<MongoQueryResult> {
        let client = conn.as_mongo();
        let coll = client
            .database(database)
            .collection::<mongodb::bson::Document>(collection);
        let filter_doc = if filter.trim().is_empty() {
            mongodb::bson::Document::new()
        } else {
            Self::parse_document(filter)?
        };
        let sort_doc = if sort.trim().is_empty() {
            None
        } else {
            Some(Self::parse_document(sort)?)
        };

        let start = std::time::Instant::now();
        let total = coll
            .count_documents(filter_doc.clone())
            .await
            .map_err(|e| AppError::Message(format!("统计文档数失败：{e}")))?;

        let mut opts = mongodb::options::FindOptions::builder()
            .skip(skip)
            .limit(limit as i64)
            .build();
        if let Some(s) = sort_doc {
            opts.sort = Some(s);
        }
        let mut cursor = coll
            .find(filter_doc)
            .with_options(opts)
            .await
            .map_err(|e| AppError::Message(format!("查询失败：{e}")))?;

        let mut documents = Vec::new();
        while let Some(doc) = cursor
            .try_next()
            .await
            .map_err(|e| AppError::Message(format!("读取文档失败：{e}")))?
        {
            documents.push(Self::doc_to_json(&doc));
        }
        Ok(MongoQueryResult {
            documents,
            total,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    pub async fn insert_one(
        conn: &DbConnection,
        database: &str,
        collection: &str,
        document: &str,
    ) -> AppResult<()> {
        let doc = Self::parse_document(document)?;
        conn.as_mongo()
            .database(database)
            .collection::<mongodb::bson::Document>(collection)
            .insert_one(doc)
            .await
            .map_err(|e| AppError::Message(format!("新增文档失败：{e}")))?;
        Ok(())
    }

    /// 按 filter 整份替换文档（编辑文档用）。
    pub async fn replace_one(
        conn: &DbConnection,
        database: &str,
        collection: &str,
        filter: &str,
        replacement: &str,
    ) -> AppResult<u64> {
        let filter_doc = Self::parse_document(filter)?;
        let replacement_doc = Self::parse_document(replacement)?;
        let result = conn
            .as_mongo()
            .database(database)
            .collection::<mongodb::bson::Document>(collection)
            .replace_one(filter_doc, replacement_doc)
            .await
            .map_err(|e| AppError::Message(format!("保存文档失败：{e}")))?;
        Ok(result.matched_count)
    }

    pub async fn delete_one(
        conn: &DbConnection,
        database: &str,
        collection: &str,
        filter: &str,
    ) -> AppResult<u64> {
        let filter_doc = Self::parse_document(filter)?;
        let result = conn
            .as_mongo()
            .database(database)
            .collection::<mongodb::bson::Document>(collection)
            .delete_one(filter_doc)
            .await
            .map_err(|e| AppError::Message(format!("删除文档失败：{e}")))?;
        Ok(result.deleted_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(database: Option<&str>, username: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: "m".into(),
            name: "m".into(),
            host: "127.0.0.1".into(),
            port: 27017,
            username: username.into(),
            database: database.map(str::to_string),
            flavor: crate::domain::DbFlavor::MongoDb,
            file_path: None,
            ssl_mode: None,
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
    fn builds_mongo_uris() {
        assert_eq!(
            connect_uri(&config(Some("mydb"), "user"), "p@ss", "h", 27017),
            "mongodb://user:p%40ss@h:27017/mydb"
        );
        assert_eq!(
            connect_uri(&config(None, ""), "", "h", 27017),
            "mongodb://h:27017"
        );
    }

    #[test]
    fn parses_documents() {
        let d = MongoDbDriver::parse_document(r#"{"a": 1}"#).unwrap();
        assert_eq!(d.get_i64("a").unwrap(), 1);
        assert!(MongoDbDriver::parse_document("{bad").is_err());
    }

    #[test]
    fn converts_extended_json_oid_back_to_objectid() {
        // 文档从库里读出时 _id 是 {"$oid":"..."}，回写（filter/replacement）要变回 ObjectId
        let d = MongoDbDriver::parse_document(
            r#"{"_id": {"$oid": "507f1f77bcf86cd799439011"}, "name": "x"}"#,
        )
        .unwrap();
        assert!(matches!(
            d.get("_id"),
            Some(mongodb::bson::Bson::ObjectId(_))
        ));
        assert_eq!(d.get_str("name").unwrap(), "x");
    }
}
