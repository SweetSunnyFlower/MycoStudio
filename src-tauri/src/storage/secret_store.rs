use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use sqlx::Row as _;

use crate::error::AppResult;
use crate::storage::LocalDb;

#[async_trait::async_trait]
pub trait SecretStore: Send + Sync {
    async fn set(&self, key: &str, value: &str) -> AppResult<()>;
    async fn get(&self, key: &str) -> AppResult<Option<String>>;
    async fn delete(&self, key: &str) -> AppResult<()>;
}

/// 密钥存本地 SQLite（和 AI 会话同一个文件）。
///
/// 之前用系统钥匙串，但 ad-hoc 签名导致每次重新构建都会重新弹授权框，
/// 体验很差；改用本地库，明文存储、文件权限 600。
pub struct SqliteSecretStore {
    db: Arc<LocalDb>,
}

impl SqliteSecretStore {
    pub fn new(db: Arc<LocalDb>) -> Self {
        Self { db }
    }
}

#[async_trait::async_trait]
impl SecretStore for SqliteSecretStore {
    async fn set(&self, key: &str, value: &str) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query(
            "INSERT INTO secrets (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
        Ok(())
    }

    async fn get(&self, key: &str) -> AppResult<Option<String>> {
        let pool = self.db.pool().await?;
        let row = sqlx::query("SELECT value FROM secrets WHERE key = ?1")
            .bind(key)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(|r| r.get(0)))
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query("DELETE FROM secrets WHERE key = ?1")
            .bind(key)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[derive(Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

#[async_trait::async_trait]
impl SecretStore for MemorySecretStore {
    async fn set(&self, key: &str, value: &str) -> AppResult<()> {
        self.map.lock().unwrap().insert(key.to_string(), value.to_string());
        Ok(())
    }

    async fn get(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self.map.lock().unwrap().get(key).cloned())
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_store_roundtrips_and_deletes() {
        let s = MemorySecretStore::default();
        assert_eq!(s.get("k").await.unwrap(), None);
        s.set("k", "v").await.unwrap();
        assert_eq!(s.get("k").await.unwrap(), Some("v".to_string()));
        s.delete("k").await.unwrap();
        assert_eq!(s.get("k").await.unwrap(), None);
    }

    #[tokio::test]
    async fn sqlite_store_roundtrips_and_overwrites() {
        let dir = std::env::temp_dir().join(format!("myco-secrets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = SqliteSecretStore::new(Arc::new(LocalDb::new(dir.join("local.sqlite"))));

        assert_eq!(s.get("conn-1").await.unwrap(), None);
        s.set("conn-1", "pw-1").await.unwrap();
        assert_eq!(s.get("conn-1").await.unwrap(), Some("pw-1".to_string()));
        // 同一个 key 覆盖写
        s.set("conn-1", "pw-2").await.unwrap();
        assert_eq!(s.get("conn-1").await.unwrap(), Some("pw-2".to_string()));
        s.delete("conn-1").await.unwrap();
        assert_eq!(s.get("conn-1").await.unwrap(), None);
    }
}
