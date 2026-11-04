use std::sync::Arc;

use sqlx::Row as _;

use crate::error::AppResult;
use crate::storage::LocalDb;

/// 通用的小配置存储（复用本地库里的 `app_settings` 表）。
///
/// 目前用来存「模型对比」的确认状态：哪些改动勾选了、哪些被忽略，
/// 键按「连接 + 库 + PDM 路径」隔离，下次打开同一次对比还能接着看。
pub struct SettingsStore {
    db: Arc<LocalDb>,
}

impl SettingsStore {
    pub fn new(db: Arc<LocalDb>) -> Self {
        Self { db }
    }

    pub async fn get(&self, key: &str) -> AppResult<Option<String>> {
        let pool = self.db.pool().await?;
        let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(|r| r.get(0)))
    }

    /// `value = None` 表示删除这个键
    pub async fn set(&self, key: &str, value: Option<&str>) -> AppResult<()> {
        let pool = self.db.pool().await?;
        match value {
            Some(v) => {
                sqlx::query(
                    "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(key)
                .bind(v)
                .execute(pool)
                .await?;
            }
            None => {
                sqlx::query("DELETE FROM app_settings WHERE key = ?1")
                    .bind(key)
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn set_get_and_delete() {
        let dir = std::env::temp_dir().join(format!("myco-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(Arc::new(LocalDb::new(dir.join("local.sqlite"))));
        assert!(store.get("k").await.unwrap().is_none());
        store.set("k", Some("v1")).await.unwrap();
        assert_eq!(store.get("k").await.unwrap().as_deref(), Some("v1"));
        store.set("k", Some("v2")).await.unwrap();
        assert_eq!(store.get("k").await.unwrap().as_deref(), Some("v2"));
        store.set("k", None).await.unwrap();
        assert!(store.get("k").await.unwrap().is_none());
    }
}
