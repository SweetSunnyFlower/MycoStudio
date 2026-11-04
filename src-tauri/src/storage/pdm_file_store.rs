use std::sync::Arc;

use sqlx::Row as _;

use crate::error::AppResult;
use crate::storage::LocalDb;

/// 打开过的 PDM 文件（给「最近打开」列表用）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PdmFileRecord {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub model_name: String,
    pub last_opened_at: i64,
}

/// PDM 文件登记表：每个打开过的文件一条记录，`id` 稳定不变。
pub struct PdmFileStore {
    db: Arc<LocalDb>,
}

impl PdmFileStore {
    pub fn new(db: Arc<LocalDb>) -> Self {
        Self { db }
    }

    /// 按路径登记并返回 id：第一次打开时生成 uuid，之后一直复用它
    /// （同时刷新文件名 / 模型名 / 最近打开时间）。
    pub async fn ensure(&self, path: &str, file_name: &str, model_name: &str) -> AppResult<String> {
        let pool = self.db.pool().await?;
        let now = chrono::Utc::now().timestamp_millis();
        let row = sqlx::query(
            "INSERT INTO pdm_files (id, path, file_name, model_name, created_at, last_opened_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
             ON CONFLICT(path) DO UPDATE SET \
                 file_name = excluded.file_name, \
                 model_name = excluded.model_name, \
                 last_opened_at = excluded.last_opened_at \
             RETURNING id",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(path)
        .bind(file_name)
        .bind(model_name)
        .bind(now)
        .fetch_one(pool)
        .await?;
        Ok(row.get(0))
    }

    /// 最近打开过的文件（按最近打开时间倒序）；文件已不存在的先不返回，
    /// 但记录和笔记都保留——文件放回原路径后还能接着用同一个 id。
    pub async fn list(&self) -> AppResult<Vec<PdmFileRecord>> {
        let pool = self.db.pool().await?;
        let rows = sqlx::query(
            "SELECT id, path, file_name, model_name, last_opened_at FROM pdm_files \
             ORDER BY last_opened_at DESC LIMIT 50",
        )
        .fetch_all(pool)
        .await?;
        let mut out = Vec::new();
        for r in rows {
            let path: String = r.get(1);
            if !std::path::Path::new(&path).exists() {
                continue;
            }
            out.push(PdmFileRecord {
                id: r.get(0),
                path,
                file_name: r.get(2),
                model_name: r.get(3),
                last_opened_at: r.get(4),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn assigns_a_stable_id_per_path() {
        let dir = std::env::temp_dir().join(format!("myco-pdm-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = PdmFileStore::new(Arc::new(LocalDb::new(dir.join("local.sqlite"))));

        let a1 = store.ensure("/a.pdm", "a.pdm", "model-a").await.unwrap();
        let a2 = store.ensure("/a.pdm", "a.pdm", "model-a2").await.unwrap();
        let b = store.ensure("/b.pdm", "b.pdm", "model-b").await.unwrap();
        assert_eq!(a1, a2, "同一路径要复用同一个 id");
        assert_ne!(a1, b, "不同文件要有不同 id");
        assert!(!a1.is_empty());

        // 文件不存在的不进最近列表
        assert!(store.list().await.unwrap().is_empty());
    }
}
