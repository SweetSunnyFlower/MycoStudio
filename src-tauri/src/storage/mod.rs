pub mod ai_chat_store;
pub mod ai_provider_store;
pub mod connection_store;
pub mod local_db;
pub mod pdm_file_store;
pub mod pdm_note_store;
pub mod secret_store;
pub mod settings_store;
pub mod sql_library_store;

pub use ai_chat_store::{AiChatStore, ChatMessage, Conversation};
pub use ai_provider_store::{AiProvider, AiProviderStore, AiProviders};
pub use connection_store::ConnectionStore;
pub use local_db::LocalDb;
pub use pdm_file_store::{PdmFileRecord, PdmFileStore};
pub use pdm_note_store::{PdmNote, PdmNoteStore};
pub use secret_store::{MemorySecretStore, SecretStore, SqliteSecretStore};
pub use settings_store::SettingsStore;
pub use sql_library_store::{SqlHistoryItem, SqlLibraryStore, SqlSavedItem};

/// 应用配置目录名（改过名字：老目录是 database-desktop）
pub const APP_DIR: &str = "myco-studio";
const LEGACY_APP_DIR: &str = "database-desktop";

/// 配置目录。首次运行时如果只有老目录，会把连接配置搬过来，避免升级后丢连接。
pub fn config_dir() -> std::path::PathBuf {
    let base = dirs::config_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join(APP_DIR);
    let legacy = base.join(LEGACY_APP_DIR);
    if !dir.exists() && legacy.exists() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(entries) = std::fs::read_dir(&legacy) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::copy(&path, dir.join(entry.file_name()));
                }
            }
        }
    }
    dir
}
