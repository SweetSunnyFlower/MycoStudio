use std::fs;
use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use tokio::sync::OnceCell;

use crate::error::AppResult;

/// 本地 SQLite：数据库密码等密钥、AI 会话都放这里。
/// 连接懒建，避免应用启动时阻塞；文件权限收紧到 600（里面有明文口令）。
pub struct LocalDb {
    path: PathBuf,
    pool: OnceCell<SqlitePool>,
}

const DDL: [&str; 13] = [
    "CREATE TABLE IF NOT EXISTS secrets (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
     )",
    // 连接配置 / AI 供应商都按「id + 整份 JSON」存：字段多、又从不按字段查询，
    // 这样结构演进不用写迁移
    "CREATE TABLE IF NOT EXISTS connections (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS ai_providers (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS sql_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        database      TEXT NOT NULL,
        sql           TEXT NOT NULL,
        created_at    INTEGER NOT NULL
     )",
    "CREATE INDEX IF NOT EXISTS idx_history_scope ON sql_history(connection_id, database, id DESC)",
    "CREATE TABLE IF NOT EXISTS sql_saved (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        database      TEXT NOT NULL,
        name          TEXT NOT NULL,
        sql           TEXT NOT NULL,
        created_at    INTEGER NOT NULL
     )",
    "CREATE INDEX IF NOT EXISTS idx_saved_scope ON sql_saved(connection_id, database, id DESC)",
    "CREATE TABLE IF NOT EXISTS conversations (
        id            TEXT PRIMARY KEY,
        connection_id TEXT,
        title         TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
     )",
    "CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        reasoning       TEXT NOT NULL DEFAULT '',
        created_at      INTEGER NOT NULL
     )",
    "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)",
    // PDM 字段笔记：不改 PDM 文件，按「文件 + 库 + 表 + 字段」关联一段 markdown
    "CREATE TABLE IF NOT EXISTS pdm_notes (
        pdm_id      TEXT NOT NULL,
        db_name     TEXT NOT NULL DEFAULT '',
        table_name  TEXT NOT NULL,
        column_name TEXT NOT NULL,
        content     TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (pdm_id, db_name, table_name, column_name)
     )",
    // 打开过的 PDM 文件登记表：给每个文件分配一个稳定 id，笔记按这个 id 关联
    "CREATE TABLE IF NOT EXISTS pdm_files (
        id             TEXT PRIMARY KEY,
        path           TEXT NOT NULL UNIQUE,
        file_name      TEXT NOT NULL,
        model_name     TEXT NOT NULL DEFAULT '',
        created_at     INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
     )",
];

/// 已经建过表的老库：缺列就补上（重复执行会报错，这里忽略即可）
const MIGRATIONS: [&str; 1] = [
    "ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''",
];

impl LocalDb {
    pub fn new(path: PathBuf) -> Self {
        Self { path, pool: OnceCell::new() }
    }

    pub async fn pool(&self) -> AppResult<&SqlitePool> {
        self.pool
            .get_or_try_init(|| async {
                // 首次运行（或换过配置目录）时父目录可能还不存在，SQLite 自己不会建，
                // 直接开库会拿到 CANTOPEN，所以这里先把目录补齐
                if let Some(parent) = self.path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let options = SqliteConnectOptions::new()
                    .filename(&self.path)
                    .create_if_missing(true);
                let pool = SqlitePoolOptions::new()
                    .max_connections(2)
                    .connect_with(options)
                    .await?;
                for ddl in DDL {
                    sqlx::query(ddl).execute(&pool).await?;
                }
                // 迁移语句允许失败（列已存在就是这种报错）
                for sql in MIGRATIONS {
                    let _ = sqlx::query(sql).execute(&pool).await;
                }
                restrict_permissions(&self.path)?;
                Ok::<SqlitePool, crate::error::AppError>(pool)
            })
            .await
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    // WAL 模式下还有 -wal / -shm 两个旁路文件，里面同样可能带明文口令
    for suffix in ["", "-wal", "-shm"] {
        let target = match suffix {
            "" => path.to_path_buf(),
            s => PathBuf::from(format!("{}{s}", path.display())),
        };
        if !target.exists() {
            continue;
        }
        let mut perm = fs::metadata(&target)?.permissions();
        perm.set_mode(0o600);
        fs::set_permissions(&target, perm)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::storage::AiChatStore;

    /// 全新机器上配置目录本身就还不存在，打开本地库时要把父目录一起建出来
    #[tokio::test]
    async fn creates_missing_parent_dir_on_first_open() {
        let base = std::env::temp_dir().join(format!("myco-first-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // 故意不创建：模拟首次运行、配置目录还不存在的机器
        let dir = base.join("myco-studio");
        let path = dir.join("local.sqlite");
        assert!(!dir.exists());

        let db = LocalDb::new(path.clone());
        db.pool().await.unwrap();

        assert!(path.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 老版本建的 messages 表没有 reasoning 列，打开本地库时要自动补上
    #[tokio::test]
    async fn adds_reasoning_column_to_old_messages_table() {
        let dir = std::env::temp_dir().join(format!("myco-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("local.sqlite");

        // 先按老结构建一张没有 reasoning 的表
        {
            let pool = SqlitePoolOptions::new()
                .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true))
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE messages (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL,
                    role            TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    created_at      INTEGER NOT NULL
                 )",
            )
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;
        }

        let store = AiChatStore::new(Arc::new(LocalDb::new(path)));
        store
            .append_with_reasoning("c1", "assistant", "答案", "先看执行计划")
            .await
            .unwrap();
        let msgs = store.messages("c1").await.unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].reasoning, "先看执行计划");
    }
}
