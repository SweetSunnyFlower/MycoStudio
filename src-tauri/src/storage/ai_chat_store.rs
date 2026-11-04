use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::Row as _;

use crate::error::AppResult;
use crate::storage::LocalDb;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    /// 会话归属的连接；不同库的表结构不同，混在一起模型会答串
    pub connection_id: Option<String>,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    /// 模型的思考过程（DeepSeek 这类会给）；空串表示没有
    #[serde(default)]
    pub reasoning: String,
    pub created_at: i64,
}

fn now_ms() -> i64 {
    // chrono 没开 clock feature，直接用标准库
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// AI 会话的本地存储。库文件和密钥共用同一个 SQLite（见 LocalDb）。
pub struct AiChatStore {
    db: Arc<LocalDb>,
}

impl AiChatStore {
    pub fn new(db: Arc<LocalDb>) -> Self {
        Self { db }
    }

    pub async fn list_conversations(&self, connection_id: Option<&str>) -> AppResult<Vec<Conversation>> {
        let pool = self.db.pool().await?;
        let rows = match connection_id {
            Some(id) => {
                sqlx::query(
                    "SELECT id, connection_id, title, created_at, updated_at FROM conversations \
                     WHERE connection_id IS ?1 ORDER BY updated_at DESC",
                )
                .bind(id)
                .fetch_all(pool)
                .await?
            }
            None => {
                sqlx::query(
                    "SELECT id, connection_id, title, created_at, updated_at FROM conversations \
                     ORDER BY updated_at DESC",
                )
                .fetch_all(pool)
                .await?
            }
        };
        Ok(rows
            .into_iter()
            .map(|r| Conversation {
                id: r.get(0),
                connection_id: r.get(1),
                title: r.get(2),
                created_at: r.get(3),
                updated_at: r.get(4),
            })
            .collect())
    }

    pub async fn create_conversation(
        &self,
        connection_id: Option<&str>,
        title: &str,
    ) -> AppResult<Conversation> {
        let pool = self.db.pool().await?;
        let now = now_ms();
        let conversation = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: connection_id.map(str::to_string),
            title: title.to_string(),
            created_at: now,
            updated_at: now,
        };
        sqlx::query(
            "INSERT INTO conversations (id, connection_id, title, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(&conversation.id)
        .bind(&conversation.connection_id)
        .bind(&conversation.title)
        .bind(conversation.created_at)
        .bind(conversation.updated_at)
        .execute(pool)
        .await?;
        Ok(conversation)
    }

    pub async fn delete_conversation(&self, id: &str) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query("DELETE FROM messages WHERE conversation_id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM conversations WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// 更新会话时间；`title` 非空时同时改标题（首条消息用来命名）。
    pub async fn touch(&self, id: &str, title: Option<&str>) -> AppResult<()> {
        let pool = self.db.pool().await?;
        match title {
            Some(t) => {
                sqlx::query("UPDATE conversations SET title = ?2, updated_at = ?3 WHERE id = ?1")
                    .bind(id)
                    .bind(t)
                    .bind(now_ms())
                    .execute(pool)
                    .await?;
            }
            None => {
                sqlx::query("UPDATE conversations SET updated_at = ?2 WHERE id = ?1")
                    .bind(id)
                    .bind(now_ms())
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn messages(&self, conversation_id: &str) -> AppResult<Vec<ChatMessage>> {
        let pool = self.db.pool().await?;
        let rows = sqlx::query(
            "SELECT id, role, content, reasoning, created_at FROM messages \
             WHERE conversation_id = ?1 ORDER BY id ASC",
        )
        .bind(conversation_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| ChatMessage {
                id: r.get(0),
                role: r.get(1),
                content: r.get(2),
                reasoning: r.get(3),
                created_at: r.get(4),
            })
            .collect())
    }

    pub async fn append(&self, conversation_id: &str, role: &str, content: &str) -> AppResult<()> {
        self.append_with_reasoning(conversation_id, role, content, "").await
    }

    pub async fn append_with_reasoning(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        reasoning: &str,
    ) -> AppResult<()> {
        let pool = self.db.pool().await?;
        sqlx::query(
            "INSERT INTO messages (conversation_id, role, content, reasoning, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(conversation_id)
        .bind(role)
        .bind(content)
        .bind(reasoning)
        .bind(now_ms())
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store(tag: &str) -> AiChatStore {
        let dir = std::env::temp_dir().join(format!("myco-chat-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        AiChatStore::new(std::sync::Arc::new(crate::storage::LocalDb::new(dir.join("local.sqlite"))))
    }

    #[tokio::test]
    async fn conversations_and_messages_roundtrip() {
        let s = store("rt").await;
        let c1 = s.create_conversation(Some("conn-a"), "第一次对话").await.unwrap();
        let c2 = s.create_conversation(Some("conn-b"), "另一个连接").await.unwrap();

        s.append(&c1.id, "user", "查一下订单").await.unwrap();
        s.append(&c1.id, "assistant", "好的").await.unwrap();
        let msgs = s.messages(&c1.id).await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].content, "好的");

        // 按连接过滤
        let only_a = s.list_conversations(Some("conn-a")).await.unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].id, c1.id);

        // 改标题 + 删除级联
        s.touch(&c2.id, Some("改了名")).await.unwrap();
        let all = s.list_conversations(None).await.unwrap();
        assert!(all.iter().any(|c| c.title == "改了名"));

        s.delete_conversation(&c1.id).await.unwrap();
        assert!(s.messages(&c1.id).await.unwrap().is_empty());
        assert_eq!(s.list_conversations(None).await.unwrap().len(), 1);
    }
}
