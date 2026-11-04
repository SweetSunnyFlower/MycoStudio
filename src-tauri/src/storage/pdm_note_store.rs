use std::sync::Arc;

use sqlx::Row as _;

use crate::error::AppResult;
use crate::storage::LocalDb;

/// 一个字段的笔记（内容为 markdown）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PdmNote {
    pub database: String,
    pub table: String,
    pub column: String,
    pub content: String,
}

/// PDM 字段笔记：独立表存储，不碰 PDM 文件本身。
pub struct PdmNoteStore {
    db: Arc<LocalDb>,
}

impl PdmNoteStore {
    pub fn new(db: Arc<LocalDb>) -> Self {
        Self { db }
    }

    pub async fn list(&self, pdm_id: &str) -> AppResult<Vec<PdmNote>> {
        let pool = self.db.pool().await?;
        let rows = sqlx::query(
            "SELECT db_name, table_name, column_name, content FROM pdm_notes \
             WHERE pdm_id = ?1 ORDER BY table_name, column_name",
        )
        .bind(pdm_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| PdmNote {
                database: r.get(0),
                table: r.get(1),
                column: r.get(2),
                content: r.get(3),
            })
            .collect())
    }

    /// 写入笔记；内容为空视为删除（这样字段上的「有笔记」标记也会跟着消失）。
    pub async fn save(
        &self,
        pdm_id: &str,
        database: &str,
        table: &str,
        column: &str,
        content: &str,
    ) -> AppResult<()> {
        if content.trim().is_empty() {
            return self.delete(pdm_id, database, table, column).await;
        }
        let pool = self.db.pool().await?;
        sqlx::query(
            "INSERT INTO pdm_notes (pdm_id, db_name, table_name, column_name, content, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(pdm_id, db_name, table_name, column_name) \
             DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
        )
        .bind(pdm_id)
        .bind(database)
        .bind(table)
        .bind(column)
        .bind(content)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(
        &self,
        pdm_id: &str,
        database: &str,
        table: &str,
        column: &str,
    ) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query(
            "DELETE FROM pdm_notes \
             WHERE pdm_id = ?1 AND db_name = ?2 AND table_name = ?3 AND column_name = ?4",
        )
        .bind(pdm_id)
        .bind(database)
        .bind(table)
        .bind(column)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saves_lists_and_deletes_notes() {
        let dir = std::env::temp_dir().join(format!("myco-pdm-notes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = PdmNoteStore::new(Arc::new(LocalDb::new(dir.join("local.sqlite"))));

        store.save("/a.pdm", "model", "users", "profile", "# 配置\n- a: 1").await.unwrap();
        store.save("/a.pdm", "model", "users", "name", "普通字段").await.unwrap();
        let notes = store.list("/a.pdm").await.unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].column, "name");
        assert_eq!(notes[1].content, "# 配置\n- a: 1");

        // 空内容 = 删除
        store.save("/a.pdm", "model", "users", "name", "   ").await.unwrap();
        let notes = store.list("/a.pdm").await.unwrap();
        assert_eq!(notes.len(), 1);

        // 别的文件互不影响
        assert!(store.list("/b.pdm").await.unwrap().is_empty());
    }
}
