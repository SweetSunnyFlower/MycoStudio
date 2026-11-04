use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::storage::{AiProvider, AiProviderStore, AiProviders};

/// 测试 Token 的结果。鉴权失败不算命令失败，就地显示给用户看。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AiTestResult {
    pub ok: bool,
    pub message: String,
    pub models: Vec<String>,
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Message(format!("HTTP 客户端初始化失败：{e}")))
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

/// 错误信息可能很长（整段 HTML），截断后再抛给界面
fn short(body: &str) -> String {
    let t = body.trim();
    let cut: String = t.chars().take(300).collect();
    if t.chars().count() > 300 {
        format!("{cut}…")
    } else {
        cut
    }
}

/// 从各种 OpenAI 兼容的返回里把模型 id 抠出来。
fn extract_model_ids(v: &serde_json::Value) -> Vec<String> {
    fn from_array(arr: &[serde_json::Value]) -> Vec<String> {
        arr.iter()
            .filter_map(|item| match item {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Object(_) => item
                    .get("id")
                    .or_else(|| item.get("name"))
                    .or_else(|| item.get("model"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                _ => None,
            })
            .collect()
    }
    if let Some(arr) = v.as_array() {
        return from_array(arr);
    }
    for key in ["data", "models", "result"] {
        if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
            let ids = from_array(arr);
            if !ids.is_empty() {
                return ids;
            }
        }
    }
    Vec::new()
}

/// 拉模型列表。返回 `None` 表示该厂商没有 `/models` 接口（404/405）。
async fn fetch_models(base_url: &str, token: &str) -> AppResult<Option<Vec<String>>> {
    let resp = client()?
        .get(endpoint(base_url, "/models"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| AppError::Message(format!("请求失败：{e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.as_u16() == 404 || status.as_u16() == 405 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(AppError::Message(format!(
            "HTTP {}：{}",
            status.as_u16(),
            short(&body)
        )));
    }
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::Message(format!("返回内容无法解析：{}", short(&body))))?;
    Ok(Some(extract_model_ids(&v)))
}

/// 最小对话：只为验证鉴权，max_tokens = 1，不关心回答内容。
async fn ping_chat(base_url: &str, token: &str, model: &str) -> AppResult<()> {
    let payload = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false
    });
    let resp = client()?
        .post(endpoint(base_url, "/chat/completions"))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::Message(format!("请求失败：{e}")))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    Err(AppError::Message(format!(
        "HTTP {}：{}",
        status.as_u16(),
        short(&body)
    )))
}

fn require_token(p: &AiProvider) -> AppResult<()> {
    if p.token.trim().is_empty() {
        return Err(AppError::Message("请先填写 Token".to_string()));
    }
    Ok(())
}

pub async fn list(store: &AiProviderStore) -> AppResult<AiProviders> {
    store.load().await
}

pub async fn save_provider(store: &AiProviderStore, provider: AiProvider) -> AppResult<AiProviders> {
    if provider.name.trim().is_empty() {
        return Err(AppError::Message("名称不能为空".to_string()));
    }
    if provider.base_url.trim().is_empty() {
        return Err(AppError::Message("地址不能为空".to_string()));
    }
    if provider.token.trim().is_empty() {
        return Err(AppError::Message("Token 必填".to_string()));
    }
    store.save(provider).await
}

pub async fn delete_provider(store: &AiProviderStore, id: &str) -> AppResult<AiProviders> {
    store.delete(id).await
}

pub async fn set_default(store: &AiProviderStore, id: &str) -> AppResult<AiProviders> {
    store.set_default(id).await
}

/// 取「当前可用」的默认供应商：没配供应商 / 没 Token / 没默认模型都算不可用。
/// 一条命令要自动跑 AI 时先过这里，不然会抛一堆看不懂的底层错误。
pub fn default_ready(providers: &AiProviders) -> AppResult<AiProvider> {
    let provider = providers
        .default_id
        .as_ref()
        .and_then(|id| providers.providers.iter().find(|p| &p.id == id))
        .ok_or_else(|| AppError::Message("还没有可用的 AI 供应商，先去「设置 → 供应商」添加".into()))?;
    if provider.token.trim().is_empty() {
        return Err(AppError::Message(
            "默认供应商还没填 Token，先去「设置 → 供应商」补上".into(),
        ));
    }
    if provider.default_model.trim().is_empty() {
        return Err(AppError::Message(
            "默认供应商还没选默认模型，先去「设置 → 供应商」设置".into(),
        ));
    }
    Ok(provider.clone())
}

/// 同步模型：调 `/models` 合并进已知模型。
///
/// 传的是表单当前值而不是存储里的旧值——用户改了 token 还没保存时，
/// 测试和同步都应该按他眼前的输入走。
pub async fn sync_models(provider: &AiProvider) -> AppResult<Vec<String>> {
    require_token(provider)?;
    if provider.base_url.trim().is_empty() {
        return Err(AppError::Message("请先填写地址".to_string()));
    }
    let fetched = fetch_models(&provider.base_url, &provider.token)
        .await?
        .ok_or_else(|| AppError::Message("该厂商没有 /models 接口，请手动添加模型".to_string()))?;

    let mut merged = provider.models.clone();
    for m in fetched {
        if !merged.contains(&m) {
            merged.push(m);
        }
    }
    Ok(merged)
}

/// 测试 Token：优先 `/models`（不消耗额度），没有该接口才发一次最小对话。
pub async fn test_provider(provider: &AiProvider) -> AppResult<AiTestResult> {
    require_token(provider)?;
    if provider.base_url.trim().is_empty() {
        return Err(AppError::Message("请先填写地址".to_string()));
    }

    let outcome = fetch_models(&provider.base_url, &provider.token).await;
    match outcome {
        Ok(Some(models)) => {
            let mut merged = provider.models.clone();
            for m in &models {
                if !merged.contains(m) {
                    merged.push(m.clone());
                }
            }
            Ok(AiTestResult {
                ok: true,
                message: format!("Token 有效 · 可用模型 {} 个", models.len()),
                models: merged,
            })
        }
        Ok(None) => {
            let model = if provider.default_model.trim().is_empty() {
                provider.models.first().cloned().unwrap_or_default()
            } else {
                provider.default_model.clone()
            };
            if model.is_empty() {
                return Err(AppError::Message(
                    "该厂商没有 /models 接口，请先填默认模型再用一次最小对话验证".to_string(),
                ));
            }
            match ping_chat(&provider.base_url, &provider.token, &model).await {
                Ok(()) => Ok(AiTestResult {
                    ok: true,
                    message: format!("Token 有效（通过一次最小对话验证，模型 {model}）"),
                    models: provider.models.clone(),
                }),
                Err(e) => Ok(AiTestResult {
                    ok: false,
                    message: e.to_string(),
                    models: provider.models.clone(),
                }),
            }
        }
        Err(e) => Ok(AiTestResult {
            ok: false,
            message: e.to_string(),
            models: provider.models.clone(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig_core::completion::{CompletionRequest, Message};
    use rig_core::providers::openai::OpenAIConfig;

    /// 编译期验证 rig-core 0.44 的 API 形状（不发请求）。
    /// 0.44 正处在 wire / transport 重构期，网站上那份文档还是老写法。
    #[test]
    fn rig_api_shapes_compile() {
        let config = OpenAIConfig::new("sk-test").with_base_url("http://127.0.0.1:1");
        let client = config.client();
        let model = client.chat("deepseek-v4-pro");

        // 多轮：preamble = system，messages = 历史，new(...) = 当前这一轮
        let history = vec![
            Message::user("查一下最近 7 天的订单"),
            Message::assistant("好的"),
        ];
        let request = CompletionRequest::new(Message::user("只看华东区的"))
            .preamble("你是数据库助手")
            .messages(history)
            .temperature(0.2);

        let _ = (model, request);
    }

    #[test]
    fn extracts_ids_from_common_shapes() {
        let openai = serde_json::json!({ "data": [{ "id": "a" }, { "id": "b" }] });
        assert_eq!(extract_model_ids(&openai), vec!["a", "b"]);

        let named = serde_json::json!({ "models": [{ "name": "qwen-plus" }] });
        assert_eq!(extract_model_ids(&named), vec!["qwen-plus"]);

        let bare = serde_json::json!(["x", "y"]);
        assert_eq!(extract_model_ids(&bare), vec!["x", "y"]);

        assert!(extract_model_ids(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn endpoint_ignores_trailing_slash() {
        assert_eq!(endpoint("https://api.deepseek.com/", "/models"), "https://api.deepseek.com/models");
        assert_eq!(endpoint("https://api.deepseek.com", "/chat/completions"), "https://api.deepseek.com/chat/completions");
    }
}
