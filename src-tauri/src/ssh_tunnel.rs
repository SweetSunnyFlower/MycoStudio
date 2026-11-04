use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::domain::ConnectionConfig;
use crate::error::{AppError, AppResult};

#[derive(Default)]
struct Client;

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 首次连接不校验主机指纹，省去「接受主机密钥」的交互；后续可以加指纹缓存
        Ok(true)
    }
}

type Handle = russh::client::Handle<Client>;

/// 保持 SSH 会话和转发任务存活，让 sqlx 连到本地端口
pub struct SshTunnel {
    pub local_port: u16,
    _session: Arc<tokio::sync::Mutex<Handle>>,
    _task: tokio::task::JoinHandle<()>,
}

/// 全局隧道注册表：连接存续期间保持隧道，断开时清理
static TUNNELS: LazyLock<Mutex<HashMap<String, SshTunnel>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn register(id: &str, tunnel: SshTunnel) {
    TUNNELS.lock().unwrap().insert(id.to_string(), tunnel);
}

pub fn unregister(id: &str) {
    TUNNELS.lock().unwrap().remove(id);
}

pub async fn start_tunnel(
    config: &ConnectionConfig,
    db_host: &str,
    db_port: u16,
    ssh_password: Option<String>,
) -> AppResult<SshTunnel> {
    let ssh_host = if config.ssh_host.trim().is_empty() {
        return Err(AppError::Message("SSH 跳板机地址为空".to_string()));
    } else {
        config.ssh_host.trim().to_string()
    };
    let ssh_port = if config.ssh_port == 0 { 22 } else { config.ssh_port };
    let user = config.ssh_user.trim().to_string();
    let user = if user.is_empty() { "root".to_string() } else { user };

    let client_config = Arc::new(russh::client::Config {
        nodelay: true,
        ..Default::default()
    });
    let mut session = russh::client::connect(client_config, (ssh_host.as_str(), ssh_port), Client)
        .await
        .map_err(|e| AppError::Message(format!("SSH 连接失败：{e}")))?;

    match config.ssh_auth_method.as_deref() {
        Some("password") => {
            let res = session
                .authenticate_password(user, ssh_password.unwrap_or_default())
                .await
                .map_err(|e| AppError::Message(format!("SSH 认证失败：{e}")))?;
            if !res.success() {
                return Err(AppError::Message("SSH 认证失败：用户名或密码错误".to_string()));
            }
        }
        _ => {
            let key_path = config
                .ssh_private_key_path
                .as_deref()
                .ok_or_else(|| AppError::Message("SSH 需要指定私钥文件".to_string()))?;
            let key = russh::keys::load_secret_key(key_path, ssh_password.as_deref())
                .map_err(|e| AppError::Message(format!("读取 SSH 私钥失败：{e}")))?;
            let hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
            let res = session
                .authenticate_publickey(
                    user,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|e| AppError::Message(format!("SSH 认证失败：{e}")))?;
            if !res.success() {
                return Err(AppError::Message("SSH 认证失败：私钥不匹配".to_string()));
            }
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let session = Arc::new(tokio::sync::Mutex::new(session));
    let db_host = db_host.to_string();

    let task = tokio::spawn({
        let session = session.clone();
        async move {
        while let Ok((stream, _addr)) = listener.accept().await {
            let session = session.clone();
            let db_host = db_host.clone();
            tokio::spawn(async move {
                let channel = {
                    let h = session.lock().await;
                    h.channel_open_direct_tcpip(db_host, db_port as u32, "127.0.0.1".to_string(), 0)
                        .await
                };
                if let Ok(mut channel) = channel {
                    pump(stream, &mut channel).await;
                }
            });
        }
        }
    });

    Ok(SshTunnel { local_port, _session: session, _task: task })
}

async fn pump(mut stream: TcpStream, channel: &mut russh::Channel<russh::client::Msg>) {
    let mut stream_closed = false;
    let mut buf = vec![0u8; 65536];
    loop {
        tokio::select! {
            r = stream.read(&mut buf), if !stream_closed => {
                match r {
                    Ok(0) => {
                        stream_closed = true;
                        let _ = channel.eof().await;
                    }
                    Ok(n) => {
                        if channel.data(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(russh::ChannelMsg::Data { data }) => {
                        if stream.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) => break,
                    Some(_) => {}
                    None => break,
                }
            }
        }
    }
}
