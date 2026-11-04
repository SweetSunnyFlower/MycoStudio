//! Redis 驱动（非关系型驱动族的第一个引擎）。
//!
//! Redis 没有「表 / 字段」这套结构，所以这里单独一套命令：
//! `db 号` 在**连接时烤进 URL**（而不是运行时 SELECT——复用连接的 SELECT 会串库），
//! 切库 = 用新 db 重连一次。


use super::DbConnection;
use crate::domain::{ConnectionConfig, RedisEntry, RedisScanResult};
use crate::error::{AppError, AppResult};

pub struct RedisDriver;

/// password 里可能有 `@ : / %` 之类会破坏 URL 的字符，手动转义
fn escape_password(password: &str) -> String {
    password
        .replace('%', "%25")
        .replace('@', "%40")
        .replace(':', "%3A")
        .replace('/', "%2F")
        .replace('?', "%3F")
}

fn connect_url(config: &ConnectionConfig, password: &str, host: &str, port: u16) -> String {
    let db = config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("0");
    if password.is_empty() {
        format!("redis://{host}:{port}/{db}")
    } else {
        format!("redis://:{}@{host}:{port}/{db}", escape_password(password))
    }
}

impl RedisDriver {
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
        let url = connect_url(config, password, &host, port);
        let client = redis::Client::open(url.as_str())
            .map_err(|e| AppError::Message(format!("Redis 连接配置无效：{e}")))?;
        let manager = redis::aio::ConnectionManager::new(client)
            .await
            .map_err(|e| AppError::Message(format!("Redis 连接失败：{e}")))?;
        // 先 ping 一下，让「测试连接 / 打开」能立刻报错而不是懒加载
        let mut probe = manager.clone();
        let _: String = redis::cmd("PING")
            .query_async(&mut probe)
            .await
            .map_err(|e| AppError::Message(format!("Redis 连接失败：{e}")))?;
        Ok(DbConnection::Redis(manager))
    }

    /// 数据库序号个数（`CONFIG GET databases` 可能被禁，失败就按 16 个）
    pub async fn database_count(conn: &DbConnection) -> u32 {
        let mut c = conn.as_redis().clone();
        let value: Option<Vec<String>> = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async(&mut c)
            .await
            .ok();
        value
            .and_then(|v| v.get(1).and_then(|n| n.parse::<u32>().ok()))
            .unwrap_or(16)
    }

    /// 按前缀 SCAN 一页。前缀为空时就是 `*`。
    pub async fn scan(
        conn: &DbConnection,
        prefix: &str,
        cursor: u64,
        count: u64,
    ) -> AppResult<RedisScanResult> {
        let mut c = conn.as_redis().clone();
        let pattern = if prefix.is_empty() {
            "*".to_string()
        } else {
            format!("{prefix}*")
        };
        let (next, keys): (String, Vec<String>) = redis::cmd("SCAN")
            .cursor_arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(count)
            .query_async(&mut c)
            .await
            .map_err(|e| AppError::Message(format!("SCAN 失败：{e}")))?;
        Ok(RedisScanResult {
            keys,
            next_cursor: next.parse::<u64>().unwrap_or(0),
        })
    }

    /// 取一个 key 的类型 + 值 + TTL + 大小
    pub async fn entry(conn: &DbConnection, key: &str) -> AppResult<RedisEntry> {
        let mut c = conn.as_redis().clone();
        let key_type: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut c)
            .await
            .map_err(|e| AppError::Message(format!("读 key 类型失败：{e}")))?;
        let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut c).await.unwrap_or(-2);

        let (value, size) = match key_type.as_str() {
            "string" => {
                let bytes: Vec<u8> = redis::cmd("GET").arg(key).query_async(&mut c).await
                .map_err(|e| AppError::Message(format!("读 key 失败：{e}")))?;
                let size = bytes.len();
                (serde_json::Value::String(String::from_utf8_lossy(&bytes).to_string()), size)
            }
            "hash" => {
                let pairs: Vec<String> = redis::cmd("HGETALL").arg(key).query_async(&mut c).await.unwrap_or_default();
                let size = pairs.len() / 2;
                let mut map = serde_json::Map::new();
                for chunk in pairs.chunks(2) {
                    map.insert(chunk[0].clone(), serde_json::Value::String(chunk[1].clone()));
                }
                (serde_json::Value::Object(map), size)
            }
            "list" => {
                let items: Vec<String> = redis::cmd("LRANGE").arg(key).arg(0).arg(-1).query_async(&mut c).await
                .map_err(|e| AppError::Message(format!("读 list 失败：{e}")))?;
                let size = items.len();
                (items.into_iter().map(serde_json::Value::String).collect(), size)
            }
            "set" => {
                let items: Vec<String> = redis::cmd("SMEMBERS").arg(key).query_async(&mut c).await.unwrap_or_default();
                let size = items.len();
                let mut items = items;
                items.sort();
                (items.into_iter().map(serde_json::Value::String).collect(), size)
            }
            "zset" => {
                // WITHSCORES 返回扁平的 [member, score, ...]
                let flat: Vec<String> = redis::cmd("ZRANGE")
                    .arg(key)
                    .arg(0)
                    .arg(-1)
                    .arg("WITHSCORES")
                    .query_async(&mut c)
                    .await
                    .map_err(|e| AppError::Message(format!("读 zset 失败：{e}")))?;
                let size = flat.len() / 2;
                let mut arr = Vec::with_capacity(size);
                for chunk in flat.chunks(2) {
                    let mut obj = serde_json::Map::new();
                    obj.insert("member".to_string(), serde_json::Value::String(chunk[0].clone()));
                    obj.insert("score".to_string(), serde_json::Value::String(chunk[1].clone()));
                    arr.push(serde_json::Value::Object(obj));
                }
                (serde_json::Value::Array(arr), size)
            }
            "stream" => {
                // 流先给个最朴素的 XRANGE - +，结构复杂、少见，能看就行
                let raw: Vec<String> =
                    redis::cmd("XRANGE").arg(key).arg("-").arg("+").query_async(&mut c).await.unwrap_or_default();
                let size = raw.len();
                (raw.into_iter().map(serde_json::Value::String).collect(), size)
            }
            _ => (serde_json::Value::Null, 0),
        };

        Ok(RedisEntry {
            key: key.to_string(),
            key_type,
            value,
            ttl,
            size,
        })
    }

    /// 设置一个 string（TTL 可选，秒）
    pub async fn set_string(conn: &DbConnection, key: &str, value: &str, ttl_seconds: Option<i64>) -> AppResult<()> {
        let mut c = conn.as_redis().clone();
        match ttl_seconds {
            Some(ttl) if ttl > 0 => {
                redis::cmd("SET").arg(key).arg(value).arg("EX").arg(ttl).query_async::<()>(&mut c).await
            }
            _ => redis::cmd("SET").arg(key).arg(value).query_async::<()>(&mut c).await,
        }
        .map_err(|e| AppError::Message(format!("写入失败：{e}")))
    }

    /// 删除一个 key
    pub async fn delete(conn: &DbConnection, key: &str) -> AppResult<()> {
        let mut c = conn.as_redis().clone();
        redis::cmd("DEL")
            .arg(key)
            .query_async::<i64>(&mut c)
            .await
            .map_err(|e| AppError::Message(format!("删除失败：{e}")))?;
        Ok(())
    }

    /// 设置过期时间（秒）
    pub async fn expire(conn: &DbConnection, key: &str, seconds: i64) -> AppResult<()> {
        let mut c = conn.as_redis().clone();
        redis::cmd("EXPIRE")
            .arg(key)
            .arg(seconds)
            .query_async::<i64>(&mut c)
            .await
            .map_err(|e| AppError::Message(format!("设置 TTL 失败：{e}")))?;
        Ok(())
    }

    /// 执行任意命令，结果转成 JSON 返回（给底部的命令行用）
    pub async fn exec(conn: &DbConnection, args: Vec<String>) -> AppResult<serde_json::Value> {
        if args.is_empty() {
            return Err(AppError::Message("命令不能为空".to_string()));
        }
        let mut c = conn.as_redis().clone();
        let mut cmd = redis::cmd(&args[0]);
        for a in &args[1..] {
            cmd.arg(a);
        }
        let result: redis::Value = cmd
            .query_async(&mut c)
            .await
            .map_err(|e| AppError::Message(format!("命令执行失败：{e}")))?;
        Ok(value_to_json(result))
    }
}

fn value_to_json(v: redis::Value) -> serde_json::Value {
    use redis::Value as Rv;
    match v {
        Rv::Nil => serde_json::Value::Null,
        Rv::Int(i) => serde_json::Value::Number(i.into()),
        Rv::BulkString(bytes) => serde_json::Value::String(String::from_utf8_lossy(&bytes).to_string()),
        Rv::SimpleString(s) => serde_json::Value::String(s),
        Rv::Okay => serde_json::Value::String("OK".to_string()),
        Rv::Double(f) => serde_json::Number::from_f64(f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null),
        Rv::Boolean(b) => serde_json::Value::Bool(b),
        Rv::Array(items) | Rv::Set(items) => items.into_iter().map(value_to_json).collect(),
        Rv::VerbatimString { text, .. } => serde_json::Value::String(text),
        Rv::BigNumber(n) => serde_json::Value::String(n.to_string()),
        Rv::Map(pairs) => {
            let mut map = serde_json::Map::new();
            for (k, val) in pairs {
                map.insert(value_to_json(k).to_string(), value_to_json(val));
            }
            serde_json::Value::Object(map)
        }
        Rv::Attribute { data, .. } => value_to_json(*data),
        Rv::Push { data, .. } => data.into_iter().map(value_to_json).collect(),
        Rv::ServerError(e) => serde_json::Value::String(e.to_string()),
        other => serde_json::Value::String(format!("{other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(port: u16, database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "r".into(),
            name: "r".into(),
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            database: database.map(str::to_string),
            flavor: crate::domain::DbFlavor::Redis,
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
    fn builds_redis_urls() {
        assert_eq!(connect_url(&config(6379, Some("2")), "", "h", 6379), "redis://h:6379/2");
        assert_eq!(connect_url(&config(6379, None), "p@ss:w", "h", 6380), "redis://:p%40ss%3Aw@h:6380/0");
        assert_eq!(connect_url(&config(6379, Some("0")), "secret", "h", 6379), "redis://:secret@h:6379/0");
    }

    #[test]
    fn converts_values_to_json() {
        use redis::Value as Rv;
        assert_eq!(value_to_json(Rv::Nil), serde_json::Value::Null);
        assert_eq!(value_to_json(Rv::Int(3)), serde_json::json!(3));
        assert_eq!(value_to_json(Rv::SimpleString("ok".into())), serde_json::json!("ok"));
        assert_eq!(value_to_json(Rv::BulkString(vec![104, 105])), serde_json::json!("hi"));
        assert_eq!(
            value_to_json(Rv::Array(vec![Rv::Int(1), Rv::BulkString(vec![97])])),
            serde_json::json!([1, "a"])
        );
    }
}
