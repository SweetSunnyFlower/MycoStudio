use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::Row as _;

use crate::error::{AppError, AppResult};
use crate::storage::LocalDb;

/// 一个 AI 供应商（OpenAI 兼容接口）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    /// 形如 https://api.deepseek.com，末尾斜杠会被忽略
    pub base_url: String,
    /// 明文存储（产品要求）；列表页直接按是否为空判断「已配置」
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiProviders {
    /// 全局唯一的默认供应商
    #[serde(default)]
    pub default_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<AiProvider>,
}

pub struct AiProviderStore {
    db: Arc<LocalDb>,
    /// 老版本的 ai-providers.json，首次读空表时导入一次
    legacy_path: PathBuf,
}

const DEFAULT_KEY: &str = "default_provider_id";

impl AiProviderStore {
    pub fn new(db: Arc<LocalDb>, legacy_path: PathBuf) -> Self {
        Self { db, legacy_path }
    }

    /// 读配置。表里没有数据时：先试老 JSON，再没有就预置 DeepSeek。
    pub async fn load(&self) -> AppResult<AiProviders> {
        let providers = self.providers().await?;
        if providers.is_empty() {
            if let Some(imported) = self.import_legacy().await? {
                return Ok(imported);
            }
            let seeded = seed();
            for provider in &seeded.providers {
                self.write(provider).await?;
            }
            self.set_default_id(seeded.default_id.as_deref()).await?;
            return Ok(seeded);
        }
        Ok(AiProviders {
            default_id: self.default_id().await?,
            providers,
        })
    }

    pub async fn get(&self, id: &str) -> AppResult<AiProvider> {
        self.load()
            .await?
            .providers
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::Message(format!("供应商不存在：{id}")))
    }

    /// 新增或按 id 更新。第一个供应商自动成为默认。
    pub async fn save(&self, provider: AiProvider) -> AppResult<AiProviders> {
        self.write(&provider).await?;
        if self.default_id().await?.is_none() {
            self.set_default_id(Some(&provider.id)).await?;
        }
        self.load().await
    }

    /// 删除；若删掉的是默认供应商，默认落到剩下的第一个（没有就置空）。
    pub async fn delete(&self, id: &str) -> AppResult<AiProviders> {
        let pool = self.db.pool().await?;
        sqlx::query("DELETE FROM ai_providers WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        if self.default_id().await?.as_deref() == Some(id) {
            let next = self.providers().await?.first().map(|p| p.id.clone());
            self.set_default_id(next.as_deref()).await?;
        }
        self.load().await
    }

    pub async fn set_default(&self, id: &str) -> AppResult<AiProviders> {
        if !self.providers().await?.iter().any(|p| p.id == id) {
            return Err(AppError::Message(format!("供应商不存在：{id}")));
        }
        self.set_default_id(Some(id)).await?;
        self.load().await
    }

    async fn providers(&self) -> AppResult<Vec<AiProvider>> {
        let pool = self.db.pool().await?;
        let rows = sqlx::query("SELECT data FROM ai_providers ORDER BY rowid")
            .fetch_all(pool)
            .await?;
        Ok(rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .filter_map(|raw| serde_json::from_str::<AiProvider>(&raw).ok())
            .collect())
    }

    async fn write(&self, provider: &AiProvider) -> AppResult<()> {
        let pool = self.db.pool().await?;
        let data = serde_json::to_string(provider)?;
        sqlx::query(
            "INSERT INTO ai_providers (id, data) VALUES (?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        )
        .bind(&provider.id)
        .bind(data)
        .execute(pool)
        .await?;
        Ok(())
    }

    async fn default_id(&self) -> AppResult<Option<String>> {
        let pool = self.db.pool().await?;
        let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?1")
            .bind(DEFAULT_KEY)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(|r| r.get(0)))
    }

    async fn set_default_id(&self, id: Option<&str>) -> AppResult<()> {
        let pool = self.db.pool().await?;
        match id {
            Some(id) => {
                sqlx::query(
                    "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(DEFAULT_KEY)
                .bind(id)
                .execute(pool)
                .await?;
            }
            None => {
                sqlx::query("DELETE FROM app_settings WHERE key = ?1")
                    .bind(DEFAULT_KEY)
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }

    /// 老版本的 ai-providers.json：导入一次后改名留底
    async fn import_legacy(&self) -> AppResult<Option<AiProviders>> {
        if !self.legacy_path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&self.legacy_path)?;
        let Ok(data) = serde_json::from_str::<AiProviders>(&raw) else {
            return Ok(None);
        };
        for provider in &data.providers {
            self.write(provider).await?;
        }
        self.set_default_id(data.default_id.as_deref()).await?;
        let _ = std::fs::rename(&self.legacy_path, self.legacy_path.with_extension("json.bak"));
        Ok(Some(data))
    }
}

/// 预置供应商：DeepSeek，token 留空等用户填写。
///
/// `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，
/// 现在的模型名是 `deepseek-v4-pro` / `deepseek-v4-flash`。
fn seed() -> AiProviders {
    let provider = AiProvider {
        id: uuid::Uuid::new_v4().to_string(),
        name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        token: String::new(),
        default_model: "deepseek-v4-pro".to_string(),
        models: vec!["deepseek-v4-pro".to_string(), "deepseek-v4-flash".to_string()],
    };
    AiProviders {
        default_id: Some(provider.id.clone()),
        providers: vec![provider],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(tag: &str) -> AiProviderStore {
        let dir = std::env::temp_dir().join(format!("myco-ai-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        AiProviderStore::new(
            Arc::new(LocalDb::new(dir.join("local.sqlite"))),
            dir.join("ai-providers.json"),
        )
    }

    #[tokio::test]
    async fn seeds_deepseek_on_first_load() {
        let store = tmp_store("seed");
        let data = store.load().await.unwrap();
        assert_eq!(data.providers.len(), 1);
        let p = &data.providers[0];
        assert_eq!(p.name, "DeepSeek");
        assert_eq!(p.base_url, "https://api.deepseek.com");
        assert_eq!(p.default_model, "deepseek-v4-pro");
        assert!(p.models.contains(&"deepseek-v4-flash".to_string()));
        assert_eq!(data.default_id.as_deref(), Some(p.id.as_str()));
    }

    #[tokio::test]
    async fn save_delete_and_default_bookkeeping() {
        let store = tmp_store("crud");
        let first = store.load().await.unwrap().providers[0].clone();

        let second = AiProvider {
            id: "second".into(),
            name: "通义千问".into(),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            token: "sk-x".into(),
            default_model: "qwen-plus".into(),
            models: vec!["qwen-plus".into()],
        };
        store.save(second.clone()).await.unwrap();
        // 第一个供应商仍然是默认
        assert_eq!(store.load().await.unwrap().default_id.as_deref(), Some(first.id.as_str()));

        store.set_default("second").await.unwrap();
        assert_eq!(store.load().await.unwrap().default_id.as_deref(), Some("second"));

        // 删掉默认 → 默认落到剩下的第一个
        let after = store.delete("second").await.unwrap();
        assert_eq!(after.default_id.as_deref(), Some(first.id.as_str()));
        assert_eq!(after.providers.len(), 1);
    }

    #[tokio::test]
    async fn imports_legacy_json_once() {
        let dir = std::env::temp_dir().join(format!("myco-ai-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("ai-providers.json");
        std::fs::write(
            &legacy,
            r#"{"default_id":"p1","providers":[{"id":"p1","name":"旧供应商","base_url":"https://x","token":"t","default_model":"m","models":["m"]}]}"#,
        )
        .unwrap();

        let store = AiProviderStore::new(
            Arc::new(LocalDb::new(dir.join("local.sqlite"))),
            legacy.clone(),
        );
        let data = store.load().await.unwrap();
        assert_eq!(data.providers.len(), 1);
        assert_eq!(data.providers[0].name, "旧供应商");
        assert_eq!(data.default_id.as_deref(), Some("p1"));
        assert!(!legacy.exists());
    }
}
