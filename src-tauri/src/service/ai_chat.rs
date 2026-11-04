use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::StreamExt;
use rig_core::completion::{AssistantContent, CompletionRequest, Message};
use rig_core::providers::openai::OpenAIConfig;
use rig_core::streaming::{Item, StreamEvent};

use crate::error::{AppError, AppResult};
use crate::driver::DbConnection;
use crate::service::connection_manager::ConnectionManager;

/// 送进模型的表结构文本上限（字符数），超了就不再塞更多表的 DDL
const DDL_BUDGET: usize = 6000;
/// 表名清单最多列多少个
const MAX_TABLE_NAMES: usize = 80;
/// 带最近多少轮历史（更早的只留一句说明）
const RECENT_TURNS: usize = 8;

/// 一轮对话需要的全部输入（供应商凭据 + system + 历史 + 本轮问题）。
pub struct ChatContext {
    pub base_url: String,
    pub token: String,
    pub model: String,
    pub system: String,
    /// (role, content)，role 为 user / assistant
    pub history: Vec<(String, String)>,
}

fn message(role: &str, content: &str) -> Message {
    if role == "assistant" {
        Message::assistant(content)
    } else {
        Message::user(content)
    }
}

fn build_request(ctx: &ChatContext, prompt: &str) -> CompletionRequest {
    let history: Vec<Message> = ctx.history.iter().map(|(r, c)| message(r, c)).collect();
    // new = 本轮问题（始终排在最后），messages = 历史，preamble = system
    CompletionRequest::new(Message::user(prompt))
        .preamble(ctx.system.clone())
        .messages(history)
        .temperature(0.2)
}

/// 跑一轮流式对话：每收到一段增量就回调一次，返回完整回复。
///
/// `cancel` 由命令层持有，用户点「停止」时置位，循环下一轮就退出。
/// 回调和返回值都区分「思考过程」和「正文」——DeepSeek 这类模型会先吐 reasoning_content。
pub struct Streamed {
    pub text: String,
    pub reasoning: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StreamKind {
    Text,
    Reasoning,
}

pub async fn chat_stream<F>(
    ctx: &ChatContext,
    prompt: &str,
    cancel: Arc<AtomicBool>,
    mut on_delta: F,
) -> AppResult<Streamed>
where
    F: FnMut(StreamKind, &str),
{
    let client = OpenAIConfig::new(ctx.token.as_str())
        .with_base_url(ctx.base_url.as_str())
        .client();
    let model = client.chat(ctx.model.as_str());
    let request = build_request(ctx, prompt);

    let mut stream = model
        .stream(request)
        .map_err(|e| AppError::Message(format!("发起请求失败：{e}")))?;

    let mut out = Streamed { text: String::new(), reasoning: String::new() };
    while let Some(item) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        match item {
            Ok(Item::Event(StreamEvent::Text { text, .. })) => {
                out.text.push_str(&text);
                on_delta(StreamKind::Text, &text);
            }
            Ok(Item::Event(StreamEvent::Reasoning { text, .. })) => {
                out.reasoning.push_str(&text);
                on_delta(StreamKind::Reasoning, &text);
            }
            // 工具调用参数等这一版不展示
            Ok(_) => {}
            Err(e) => return Err(AppError::Message(format!("流式响应出错：{e}"))),
        }
    }
    Ok(out)
}

/// 一次性（非流式）调用，留给「测试 Token 的有效性」这类不需要打字机的场景。
pub async fn chat_once(ctx: &ChatContext, prompt: &str) -> AppResult<String> {
    let client = OpenAIConfig::new(ctx.token.as_str())
        .with_base_url(ctx.base_url.as_str())
        .client();
    let model = client.chat(ctx.model.as_str());
    let response = model
        .call(build_request(ctx, prompt))
        .await
        .map_err(|e| AppError::Message(format!("请求失败：{e}")))?;

    let mut out = String::new();
    for item in response.choice {
        if let AssistantContent::Text(t) = item {
            out.push_str(&t.text);
        }
    }
    Ok(out)
}

/// 拼 system：角色与规则 + 当前库 + 表名清单 + 相关表的 DDL。
///
/// 裁剪策略：表名全列（只列名字，便宜），DDL 只带「用户这轮提到的表」和
/// 「工作台当前选中的表」——大库全量 DDL 会直接把上下文撑爆。
pub async fn build_context(
    manager: &ConnectionManager,
    connection_id: Option<&str>,
    database: &str,
    current_table: Option<&str>,
    text: &str,
) -> String {
    let mut sys = String::from(
        "你是 Myco Studio（桌面数据库客户端）里的数据库助手。\n\
         规则：\n\
         1. 只依据下面给出的表结构回答，不要臆造表名或字段名；信息不足就直接说不确定并让用户补充。\n\
         2. 需要给 SQL 时用 ```sql 代码块，并在代码块外简短说明思路。\n\
         3. 回答用中文，简洁，不要复述问题。\n",
    );

    let Some(conn_id) = connection_id else {
        sys.push_str("\n（用户当前没有打开任何连接，没有表结构可用）\n");
        return sys;
    };
    let Ok(conn) = manager.get(conn_id) else {
        sys.push_str("\n（连接尚未建立，没有表结构可用）\n");
        return sys;
    };
    // Redis 没有表 / 字段 / SQL，给一套专用的 system，别让它掉进关系型的表结构分支。
    if matches!(conn, DbConnection::Redis(_)) {
        if database.is_empty() {
            sys.push_str("\n（用户还没选中 Redis 库，默认 db 0）\n");
        } else {
            sys.push_str(&format!("\n当前 Redis 数据库索引：db{database}\n"));
        }
        sys.push_str(
            "这是 Redis 连接（非关系型，不支持 SQL）。\n\
             用户会问关于 key、数据结构（string / hash / list / set / zset / stream）、TTL、\
             以及 Redis 命令的问题。回答时：\n\
             1. 优先给出可直接粘贴到客户端命令行执行的 Redis 命令，用 ```redis 代码块。\n\
             2. 涉及 key 名时优先使用用户提到的 key；信息不足就直接说需要哪些信息。\n\
             3. 不要生成 SQL。\n",
        );
        return sys;
    }
    // MongoDB：文档库，没有 SQL，给一套专用的 system。
    if matches!(conn, DbConnection::MongoDb(_)) {
        if database.is_empty() {
            sys.push_str("\n（用户还没选中数据库）\n");
        } else {
            sys.push_str(&format!("\n当前 MongoDB 数据库：{database}\n"));
            if let Ok(collections) =
                crate::driver::mongodb_driver::MongoDbDriver::list_collections(&conn, database).await
            {
                if collections.is_empty() {
                    sys.push_str("这个库里还没有集合。\n");
                } else {
                    sys.push_str(&format!(
                        "集合清单（{} 个）：{}\n",
                        collections.len(),
                        collections.join(", ")
                    ));
                }
            }
        }
        sys.push_str(
            "这是 MongoDB 连接（文档数据库，不支持 SQL）。\n\
             用户会问关于数据库、集合、文档、以及 MongoDB 查询（find / aggregate / update）的问题。\n\
             回答时：\n\
             1. 查询示例用 MongoDB 查询语法（JSON filter / pipeline），放在 ```js 或 ```json 代码块里，\
             并说明是放到哪个集合上执行。\n\
             2. 涉及字段名时优先使用用户提到的字段；信息不足就直接说需要哪些信息。\n\
             3. 不要生成 SQL。\n",
        );
        return sys;
    }
    // Elasticsearch：REST + DSL，不是 SQL。
    if matches!(conn, DbConnection::Elasticsearch(_)) {
        sys.push_str(
            "这是 Elasticsearch 连接（REST + Query DSL，不支持 SQL）。\n\
             用户会问索引、文档、以及 ES 查询的问题。回答时：\n\
             1. 查询示例用 ES Query DSL，放在 ```json 代码块里，并说明是打到哪个索引的 _search。\n\
             2. 涉及字段名时优先使用用户提到的字段；信息不足就直接说需要哪些信息。\n\
             3. 不要生成 SQL。\n",
        );
        if let Ok(info) =
            crate::driver::elasticsearch_driver::ElasticsearchDriver::cluster_info(&conn).await
        {
            sys.push_str(&format!("\n当前集群：{}（{}）\n", info.name, info.version));
        }
        // 当前索引的字段（mapping），模型才能回答"有哪些字段"
        if let Some(index) = current_table.filter(|t| !t.is_empty()) {
            sys.push_str(&format!("\n当前索引：{index}\n"));
            if let Ok(fields) =
                crate::driver::elasticsearch_driver::ElasticsearchDriver::fields(&conn, index).await
            {
                if fields.is_empty() {
                    sys.push_str("（这个索引还没有字段映射）\n");
                } else {
                    let shown: Vec<String> = fields.iter().take(150).cloned().collect();
                    sys.push_str(&format!("字段（{} 个）：{}\n", fields.len(), shown.join(", ")));
                }
            }
        }
        if let Ok(indices) =
            crate::driver::elasticsearch_driver::ElasticsearchDriver::list_indices(&conn).await
        {
            let shown: Vec<String> = indices.iter().take(80).cloned().collect();
            if !shown.is_empty() {
                sys.push_str(&format!("索引清单（{} 个）：{}\n", indices.len(), shown.join(", ")));
            }
        }
        return sys;
    }
    if database.is_empty() {
        sys.push_str("\n（用户还没选中库，没有表结构可用）\n");
        return sys;
    }

    sys.push_str(&format!("\n当前库 / schema：{database}\n"));

    let tables = match crate::driver::list_tables(&conn, database).await {
        Ok(t) => t,
        Err(_) => {
            sys.push_str("（读取表清单失败，没有表结构可用）\n");
            return sys;
        }
    };
    let names: Vec<String> = tables.iter().map(|t| t.name.clone()).collect();
    if names.is_empty() {
        sys.push_str("这个库里还没有表。\n");
        return sys;
    }
    let shown = names.iter().take(MAX_TABLE_NAMES).cloned().collect::<Vec<_>>().join(", ");
    sys.push_str(&format!("表清单（{} 张）：{}\n", names.len(), shown));

    // 关键词匹配：这轮消息 + 当前选中的表
    let haystack = text.to_lowercase();
    let mut picked: Vec<String> = Vec::new();
    if let Some(t) = current_table.filter(|t| !t.is_empty()) {
        picked.push(t.to_string());
    }
    for name in &names {
        if picked.len() >= 12 {
            break;
        }
        if haystack.contains(&name.to_lowercase()) && !picked.contains(name) {
            picked.push(name.clone());
        }
    }

    if picked.is_empty() {
        sys.push_str("（用户这轮没提到具体表；需要字段级信息时先问他指的是哪张表）\n");
        return sys;
    }

    sys.push_str("\n相关表结构：\n");
    let mut used = 0usize;
    for name in picked {
        if used >= DDL_BUDGET {
            sys.push_str("（表结构过多，其余已省略）\n");
            break;
        }
        if let Ok(ddl) = crate::driver::table_ddl(&conn, database, &name).await {
            used += ddl.len();
            sys.push_str(&format!("```sql\n{ddl}\n```\n"));
        }
    }
    sys
}

/// 只保留最近若干轮，更早的压成一句说明（不额外花钱做摘要）。
pub fn trim_history(history: &[(String, String)]) -> Vec<(String, String)> {
    if history.len() <= RECENT_TURNS {
        return history.to_vec();
    }
    let skipped = history.len() - RECENT_TURNS;
    let mut out = vec![(
        "user".to_string(),
        format!("（之前还有 {skipped} 条对话，已省略）"),
    )];
    out.extend_from_slice(&history[skipped..]);
    out
}

/// 「执行计划」标签页里自动跑的分析提示词（表结构已经由 build_context 放进 system）。
pub fn plan_analysis_prompt(sql: Option<&str>, plan: &str) -> String {
    let mut out = String::new();
    if let Some(sql) = sql.filter(|s| !s.trim().is_empty()) {
        out.push_str("被分析的 SQL：\n```sql\n");
        out.push_str(sql.trim());
        out.push_str("\n```\n\n");
    }
    out.push_str("执行计划（EXPLAIN 的输出）：\n```\n");
    out.push_str(plan.trim());
    out.push_str(
        "\n```\n\n\
         请用中文分析这条查询的执行计划，按 Markdown 输出，结构如下：\n\
         1. **一句话结论**：这条查询快不快、主要慢在哪。\n\
         2. **逐行看**：哪些行是全表扫描、没走索引、用了临时表或文件排序、预估扫描行数偏大。\
         把关键列（type / key / rows / Extra 之类）点出来，别整段复述。\n\
         3. **优化建议**：能加索引就给 CREATE INDEX 语句（放在 sql 代码块里）；\
         如果是写法问题就给改写后的 SQL。没有明显问题就直说。\n",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_prompt_carries_sql_and_plan() {
        let p = plan_analysis_prompt(Some("SELECT 1"), "id | select_type\n1 | SIMPLE");
        assert!(p.contains("SELECT 1"));
        assert!(p.contains("SIMPLE"));
        assert!(p.contains("CREATE INDEX"));

        // 没有 SQL（比如只跑了 EXPLAIN）也不能缺计划本体
        let p = plan_analysis_prompt(None, "SIMPLE");
        assert!(!p.contains("被分析的 SQL"));
        assert!(p.contains("SIMPLE"));
    }
}
