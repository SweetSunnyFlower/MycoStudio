use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::domain::ConnectionConfig;
use crate::driver::{self, DbConnection};
use crate::error::{AppError, AppResult};
use crate::storage::{ConnectionStore, SecretStore};

pub struct ConnectionManager {
    store: ConnectionStore,
    secrets: Arc<dyn SecretStore>,
    pools: Mutex<HashMap<String, DbConnection>>,
}

impl ConnectionManager {
    pub fn new(store: ConnectionStore, secrets: Arc<dyn SecretStore>) -> Self {
        Self { store, secrets, pools: Mutex::new(HashMap::new()) }
    }

    pub fn store(&self) -> &ConnectionStore {
        &self.store
    }

    pub async fn config(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.store
            .load_all()
            .await?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }

    pub async fn connect(&self, id: &str) -> AppResult<()> {
        let config = self.config(id).await?;
        // 允许无密码连接：未保存密码时回退为空字符串（本地 MySQL root 常为空密码）。
        let password = self.secrets.get(id).await?.unwrap_or_default();
        // 只有开了 SSH 隧道才去读跳板机口令，少一次本地库查询
        let ssh_password = if config.ssh_enabled {
            self.secrets.get(&format!("{id}:ssh")).await.ok().flatten()
        } else {
            None
        };
        let conn = driver::connect(&config, &password, ssh_password).await?;
        self.pools.lock().unwrap().insert(id.to_string(), conn);
        Ok(())
    }

    /// Redis 切库：db 号烤在连接 URL 里，所以换库就是「用新的 db 重连一次」。
    pub async fn connect_with_db(&self, id: &str, db: &str) -> AppResult<()> {
        let mut config = self.config(id).await?;
        config.database = Some(db.to_string());
        let password = self.secrets.get(id).await?.unwrap_or_default();
        let ssh_password = if config.ssh_enabled {
            self.secrets.get(&format!("{id}:ssh")).await.ok().flatten()
        } else {
            None
        };
        let conn = driver::connect(&config, &password, ssh_password).await?;
        self.pools.lock().unwrap().insert(id.to_string(), conn);
        Ok(())
    }

    pub fn disconnect(&self, id: &str) {
        self.pools.lock().unwrap().remove(id);
        crate::ssh_tunnel::unregister(id);
    }

    pub fn get(&self, id: &str) -> AppResult<DbConnection> {
        self.pools
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }
}
