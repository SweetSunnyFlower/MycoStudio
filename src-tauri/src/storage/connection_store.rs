use std::path::PathBuf;
use std::sync::Arc;

use sqlx::Row as _;

use crate::domain::ConnectionConfig;
use crate::error::AppResult;
use crate::storage::LocalDb;

/// 连接配置存本地 SQLite（整份配置按 JSON 放一行）。
///
/// 以前是 connections.json 整文件重写：写一半崩了会损坏、并发写会互相覆盖。
/// 现在靠 SQLite 的事务性解决，同时第一次读空表时会导入老的 JSON 再改名留底。
pub struct ConnectionStore {
    db: Arc<LocalDb>,
    legacy_path: PathBuf,
}

impl ConnectionStore {
    pub fn new(db: Arc<LocalDb>, legacy_path: PathBuf) -> Self {
        Self { db, legacy_path }
    }

    pub async fn load_all(&self) -> AppResult<Vec<ConnectionConfig>> {
        let pool = self.db.pool().await?;
        // rowid 保持插入顺序，列表顺序和以前一致
        let rows = sqlx::query("SELECT data FROM connections ORDER BY rowid")
            .fetch_all(pool)
            .await?;
        if rows.is_empty() {
            if let Some(list) = self.import_legacy().await? {
                return Ok(list);
            }
        }
        Ok(rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .filter_map(|raw| serde_json::from_str::<ConnectionConfig>(&raw).ok())
            .collect())
    }

    pub async fn save(&self, config: &ConnectionConfig) -> AppResult<()> {
        let pool = self.db.pool().await?;
        let data = serde_json::to_string(config)?;
        sqlx::query(
            "INSERT INTO connections (id, data) VALUES (?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        )
        .bind(&config.id)
        .bind(data)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query("DELETE FROM connections WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// 老版本的 connections.json：导入一次，然后把文件改名成 .bak 留底
    async fn import_legacy(&self) -> AppResult<Option<Vec<ConnectionConfig>>> {
        if !self.legacy_path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&self.legacy_path)?;
        let list: Vec<ConnectionConfig> = serde_json::from_str(&raw).unwrap_or_default();
        for config in &list {
            self.save(config).await?;
        }
        let _ = std::fs::rename(&self.legacy_path, self.legacy_path.with_extension("json.bak"));
        Ok(Some(list))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::DbFlavor;

    fn cfg(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: format!("conn-{id}"),
            host: "127.0.0.1".into(),
            port: 3306,
            username: "root".into(),
            database: None,
            flavor: DbFlavor::Mysql,
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

    fn store_in(dir: &std::path::Path) -> ConnectionStore {
        ConnectionStore::new(
            Arc::new(LocalDb::new(dir.join("local.sqlite"))),
            dir.join("connections.json"),
        )
    }

    #[tokio::test]
    async fn saves_loads_and_deletes() {
        let dir = std::env::temp_dir().join(format!("cdtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = store_in(&dir);
        store.save(&cfg("a")).await.unwrap();
        store.save(&cfg("b")).await.unwrap();
        // 顺序按插入先后
        let ids: Vec<String> = store.load_all().await.unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
        store.delete("a").await.unwrap();
        assert_eq!(store.load_all().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn loads_empty_when_missing() {
        let dir = std::env::temp_dir().join(format!("cdtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(store_in(&dir).load_all().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn imports_legacy_json_once() {
        let dir = std::env::temp_dir().join(format!("cdtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("connections.json");
        std::fs::write(&legacy, serde_json::to_string(&vec![cfg("old")]).unwrap()).unwrap();

        let store = store_in(&dir);
        let loaded = store.load_all().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "old");
        assert!(!legacy.exists(), "导入后原文件应改名留底");
        assert!(dir.join("connections.json.bak").exists());
    }
}
