use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::Row as _;

use crate::error::AppResult;
use crate::storage::LocalDb;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlHistoryItem {
    pub id: i64,
    pub sql: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlSavedItem {
    pub id: i64,
    pub name: String,
    pub sql: String,
    pub created_at: i64,
}

/// 每个「连接 + 库」最多留这么多条历史（和以前 localStorage 版本一致）
const HISTORY_LIMIT: i64 = 50;

/// SQL 历史与收藏。以前在 localStorage：有 5MB 上限、清缓存就丢、也没法搜索；
/// 挪到本地库后可以和连接/密钥一起备份，后面还能给 AI 当上下文。
pub struct SqlLibraryStore {
    db: Arc<LocalDb>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl SqlLibraryStore {
    pub fn new(db: Arc<LocalDb>) -> Self {
        Self { db }
    }

    pub async fn history(&self, connection_id: &str, database: &str) -> AppResult<Vec<SqlHistoryItem>> {
        let pool = self.db.pool().await?;
        let rows = sqlx::query(
            "SELECT id, sql, created_at FROM sql_history \
             WHERE connection_id = ?1 AND database = ?2 ORDER BY id DESC",
        )
        .bind(connection_id)
        .bind(database)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| SqlHistoryItem {
                id: r.get(0),
                sql: r.get(1),
                created_at: r.get(2),
            })
            .collect())
    }

    /// 记一条历史：同一条 SQL 先删旧的（相当于「置顶」），再裁到上限。
    pub async fn push_history(
        &self,
        connection_id: &str,
        database: &str,
        sql: &str,
    ) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query("DELETE FROM sql_history WHERE connection_id = ?1 AND database = ?2 AND sql = ?3")
            .bind(connection_id)
            .bind(database)
            .bind(sql)
            .execute(pool)
            .await?;
        sqlx::query(
            "INSERT INTO sql_history (connection_id, database, sql, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(connection_id)
        .bind(database)
        .bind(sql)
        .bind(now_ms())
        .execute(pool)
        .await?;
        sqlx::query(
            "DELETE FROM sql_history WHERE connection_id = ?1 AND database = ?2 AND id NOT IN (\
                SELECT id FROM sql_history WHERE connection_id = ?1 AND database = ?2 \
                ORDER BY id DESC LIMIT ?3)",
        )
        .bind(connection_id)
        .bind(database)
        .bind(HISTORY_LIMIT)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn saved(&self, connection_id: &str, database: &str) -> AppResult<Vec<SqlSavedItem>> {
        let pool = self.db.pool().await?;
        let rows = sqlx::query(
            "SELECT id, name, sql, created_at FROM sql_saved \
             WHERE connection_id = ?1 AND database = ?2 ORDER BY id DESC",
        )
        .bind(connection_id)
        .bind(database)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| SqlSavedItem {
                id: r.get(0),
                name: r.get(1),
                sql: r.get(2),
                created_at: r.get(3),
            })
            .collect())
    }

    pub async fn save_sql(
        &self,
        connection_id: &str,
        database: &str,
        name: &str,
        sql: &str,
    ) -> AppResult<SqlSavedItem> {
        let pool = self.db.pool().await?;
        let created_at = now_ms();
        let row = sqlx::query(
            "INSERT INTO sql_saved (connection_id, database, name, sql, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
        )
        .bind(connection_id)
        .bind(database)
        .bind(name)
        .bind(sql)
        .bind(created_at)
        .fetch_one(pool)
        .await?;
        Ok(SqlSavedItem {
            id: row.get(0),
            name: name.to_string(),
            sql: sql.to_string(),
            created_at,
        })
    }

    pub async fn delete_saved(&self, id: i64) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query("DELETE FROM sql_saved WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store(tag: &str) -> SqlLibraryStore {
        let dir = std::env::temp_dir().join(format!("myco-sql-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        SqlLibraryStore::new(Arc::new(LocalDb::new(dir.join("local.sqlite"))))
    }

    #[tokio::test]
    async fn history_dedupes_and_keeps_newest_first() {
        let s = store("history").await;
        s.push_history("c1", "db", "SELECT 1").await.unwrap();
        s.push_history("c1", "db", "SELECT 2").await.unwrap();
        // 重复执行 SELECT 1 → 置顶而不是新增
        s.push_history("c1", "db", "SELECT 1").await.unwrap();

        let list = s.history("c1", "db").await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].sql, "SELECT 1");
        assert_eq!(list[1].sql, "SELECT 2");

        // 不同库互不干扰
        assert!(s.history("c1", "other").await.unwrap().is_empty());
        assert!(s.history("c2", "db").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn history_is_capped() {
        let s = store("cap").await;
        for i in 0..(HISTORY_LIMIT + 5) {
            s.push_history("c1", "db", &format!("SELECT {i}")).await.unwrap();
        }
        assert_eq!(s.history("c1", "db").await.unwrap().len() as i64, HISTORY_LIMIT);
    }

    #[tokio::test]
    async fn saved_roundtrip() {
        let s = store("saved").await;
        let item = s.save_sql("c1", "db", "日活", "SELECT 1").await.unwrap();
        let list = s.saved("c1", "db").await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "日活");
        s.delete_saved(item.id).await.unwrap();
        assert!(s.saved("c1", "db").await.unwrap().is_empty());
    }
}
