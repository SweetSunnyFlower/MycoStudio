use std::sync::Arc;

use tauri::State;

use crate::domain::{
    Change, ConnectionConfig, EsClusterInfo, EsSearchResult, FilterSpec, MongoQueryResult,
    RedisEntry, RedisScanResult, ResultSet, TableSchema,
};
use crate::driver::{ColumnInfo, Page, TableInfo};
use crate::error::AppResult;
use crate::service::{
    BrowsedTable, ConnectionManager, IntrospectionService, MutationService, QueryService,
    io::{ExportFormat, ImportColumn, ImportPreview, ImportReport, SqlFileReport},
};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use crate::storage::{
    AiChatStore, AiProvider, AiProviderStore, AiProviders, ConnectionStore, Conversation, LocalDb,
    PdmFileRecord, PdmFileStore, PdmNote, PdmNoteStore, SecretStore, SettingsStore,
    SqliteSecretStore, SqlHistoryItem, SqlLibraryStore, SqlSavedItem,
};

pub struct AppState {
    pub manager: ConnectionManager,
    pub secrets: Arc<dyn SecretStore>,
    pub ai: AiProviderStore,
    pub ai_chat: AiChatStore,
    pub sql_library: SqlLibraryStore,
    /// 通用小配置（模型对比的确认状态等）
    pub settings: SettingsStore,
    /// PDM 字段笔记（独立表，不写回 PDM 文件）
    pub pdm_notes: PdmNoteStore,
    /// 打开过的 PDM 文件（分配稳定 id）
    pub pdm_files: PdmFileStore,
    /// 正在跑的对话：会话 id → 取消标记
    pub chat_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub fn build_state(dir: std::path::PathBuf) -> AppState {
    // 密钥和 AI 会话共用一个本地 SQLite（不再用系统钥匙串）。
    // 老版本 AI 会话单独放在 ai.sqlite，第一次跑新版本时搬过来，别把历史聊没了。
    let db_path = dir.join("local.sqlite");
    let legacy = dir.join("ai.sqlite");
    if !db_path.exists() && legacy.exists() {
        let _ = std::fs::copy(&legacy, &db_path);
    }
    let db = Arc::new(LocalDb::new(db_path));
    let secrets: Arc<dyn SecretStore> = Arc::new(SqliteSecretStore::new(db.clone()));
    // 连接配置和供应商也挪进同一个库；老 JSON 由各自 store 在首次读空表时导入
    let store = ConnectionStore::new(db.clone(), dir.join("connections.json"));
    let ai = AiProviderStore::new(db.clone(), dir.join("ai-providers.json"));
    let ai_chat = AiChatStore::new(db.clone());
    let settings = SettingsStore::new(db.clone());
    let pdm_notes = PdmNoteStore::new(db.clone());
    let pdm_files = PdmFileStore::new(db.clone());
    let sql_library = SqlLibraryStore::new(db);
    AppState {
        manager: ConnectionManager::new(store, secrets.clone()),
        secrets,
        ai,
        ai_chat,
        sql_library,
        settings,
        pdm_notes,
        pdm_files,
        chat_cancels: Mutex::new(HashMap::new()),
    }
}

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    state.manager.store().load_all().await
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
) -> AppResult<ConnectionConfig> {
    state.manager.store().save(&config).await?;
    if let Some(pw) = password {
        state.secrets.set(&config.id, &pw).await?;
    }
    if let Some(pw) = ssh_password {
        state.secrets.set(&format!("{}:ssh", config.id), &pw).await?;
    }
    Ok(config)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.disconnect(&id);
    state.manager.store().delete(&id).await?;
    state.secrets.delete(&id).await?;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_password: Option<String>,
) -> AppResult<()> {
    // 编辑已有连接时密码框留空 = 沿用已保存的密码（新建连接没有已保存密码，回退成空串）
    let password = match password.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => state.secrets.get(&config.id).await?.unwrap_or_default(),
    };
    let ssh_password = match ssh_password.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None if config.ssh_enabled => {
            state.secrets.get(&format!("{}:ssh", config.id)).await.ok().flatten()
        }
        None => None,
    };
    let conn = crate::driver::connect(&config, &password, ssh_password).await?;
    match conn {
        crate::driver::DbConnection::Mysql(p) => p.close().await,
        crate::driver::DbConnection::Postgres(p) => p.close().await,
        crate::driver::DbConnection::Sqlite(p) => p.close().await,
        // Oracle 连接是阻塞式的，离开作用域由 Drop 关闭
        crate::driver::DbConnection::Oracle(_) => {}
        // Redis 的 ConnectionManager 离开作用域自动回收
        crate::driver::DbConnection::Redis(_) => {}
        // MongoDB 的 Client 是连接池句柄，drop 后连接由池回收
        crate::driver::DbConnection::MongoDb(_) => {}
        // ES 的连接是 reqwest::Client（连接池），drop 即回收
        crate::driver::DbConnection::Elasticsearch(_) => {}
    }
    crate::ssh_tunnel::unregister(&config.id);
    Ok(())
}

#[tauri::command]
pub async fn test_saved_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let config = state.manager.config(&id).await?;
    let password = state.secrets.get(&id).await?.unwrap_or_default();
    let ssh_password = if config.ssh_enabled {
        state.secrets.get(&format!("{id}:ssh")).await.ok().flatten()
    } else {
        None
    };
    let conn = crate::driver::connect(&config, &password, ssh_password).await?;
    match conn {
        crate::driver::DbConnection::Mysql(p) => p.close().await,
        crate::driver::DbConnection::Postgres(p) => p.close().await,
        crate::driver::DbConnection::Sqlite(p) => p.close().await,
        crate::driver::DbConnection::Oracle(_) => {}
        crate::driver::DbConnection::Redis(_) => {}
        crate::driver::DbConnection::MongoDb(_) => {}
        crate::driver::DbConnection::Elasticsearch(_) => {}
    }
    crate::ssh_tunnel::unregister(&id);
    Ok(())
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.connect(&id).await
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>, id: String) {
    state.manager.disconnect(&id);
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    IntrospectionService::list_databases(&state.manager, &id).await
}

#[tauri::command]
pub async fn redis_scan(
    state: State<'_, AppState>,
    id: String,
    prefix: String,
    cursor: u64,
    count: u64,
) -> AppResult<RedisScanResult> {
    let conn = state.manager.get(&id)?;
    crate::driver::redis_driver::RedisDriver::scan(&conn, &prefix, cursor, count).await
}

#[tauri::command]
pub async fn redis_entry(
    state: State<'_, AppState>,
    id: String,
    key: String,
) -> AppResult<RedisEntry> {
    let conn = state.manager.get(&id)?;
    crate::driver::redis_driver::RedisDriver::entry(&conn, &key).await
}

#[tauri::command]
pub async fn redis_set_string(
    state: State<'_, AppState>,
    id: String,
    key: String,
    value: String,
    ttl_seconds: Option<i64>,
) -> AppResult<()> {
    let conn = state.manager.get(&id)?;
    crate::driver::redis_driver::RedisDriver::set_string(&conn, &key, &value, ttl_seconds).await
}

#[tauri::command]
pub async fn redis_delete(
    state: State<'_, AppState>,
    id: String,
    key: String,
) -> AppResult<()> {
    let conn = state.manager.get(&id)?;
    crate::driver::redis_driver::RedisDriver::delete(&conn, &key).await
}

#[tauri::command]
pub async fn redis_expire(
    state: State<'_, AppState>,
    id: String,
    key: String,
    seconds: i64,
) -> AppResult<()> {
    let conn = state.manager.get(&id)?;
    crate::driver::redis_driver::RedisDriver::expire(&conn, &key, seconds).await
}

#[tauri::command]
pub async fn redis_exec(
    state: State<'_, AppState>,
    id: String,
    args: Vec<String>,
) -> AppResult<serde_json::Value> {
    let conn = state.manager.get(&id)?;
    crate::driver::redis_driver::RedisDriver::exec(&conn, args).await
}

/// Redis 切库：db 号烤在连接 URL 里，切库 = 用新 db 重连一次。
#[tauri::command]
pub async fn redis_select_db(state: State<'_, AppState>, id: String, db: String) -> AppResult<()> {
    state.manager.connect_with_db(&id, &db).await
}

#[tauri::command]
pub async fn mongodb_list_collections(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<String>> {
    let conn = state.manager.get(&id)?;
    crate::driver::mongodb_driver::MongoDbDriver::list_collections(&conn, &database).await
}

#[tauri::command]
pub async fn mongodb_find(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    sort: String,
    skip: u64,
    limit: u64,
) -> AppResult<MongoQueryResult> {
    let conn = state.manager.get(&id)?;
    crate::driver::mongodb_driver::MongoDbDriver::find(
        &conn, &database, &collection, &filter, &sort, skip, limit,
    )
    .await
}

#[tauri::command]
pub async fn mongodb_insert_one(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    document: String,
) -> AppResult<()> {
    let conn = state.manager.get(&id)?;
    crate::driver::mongodb_driver::MongoDbDriver::insert_one(&conn, &database, &collection, &document)
        .await
}

#[tauri::command]
pub async fn mongodb_replace_one(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    replacement: String,
) -> AppResult<u64> {
    let conn = state.manager.get(&id)?;
    crate::driver::mongodb_driver::MongoDbDriver::replace_one(
        &conn, &database, &collection, &filter, &replacement,
    )
    .await
}

#[tauri::command]
pub async fn mongodb_delete_one(
    state: State<'_, AppState>,
    id: String,
    database: String,
    collection: String,
    filter: String,
) -> AppResult<u64> {
    let conn = state.manager.get(&id)?;
    crate::driver::mongodb_driver::MongoDbDriver::delete_one(&conn, &database, &collection, &filter)
        .await
}

#[tauri::command]
pub async fn es_cluster_info(state: State<'_, AppState>, id: String) -> AppResult<EsClusterInfo> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::cluster_info(&conn).await
}

#[tauri::command]
pub async fn es_indices(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::list_indices(&conn).await
}

#[tauri::command]
pub async fn es_fields(
    state: State<'_, AppState>,
    id: String,
    index: String,
) -> AppResult<Vec<String>> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::fields(&conn, &index).await
}

#[tauri::command]
pub async fn es_search(
    state: State<'_, AppState>,
    id: String,
    index: String,
    body: String,
) -> AppResult<EsSearchResult> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::search(&conn, &index, &body).await
}

#[tauri::command]
pub async fn es_index_doc(
    state: State<'_, AppState>,
    id: String,
    index: String,
    doc_id: Option<String>,
    document: String,
) -> AppResult<serde_json::Value> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::index_doc(
        &conn,
        &index,
        doc_id.as_deref(),
        &document,
    )
    .await
}

#[tauri::command]
pub async fn es_create_index(
    state: State<'_, AppState>,
    id: String,
    index: String,
    body: String,
) -> AppResult<serde_json::Value> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::create_index(&conn, &index, &body).await
}

#[tauri::command]
pub async fn es_delete_index(
    state: State<'_, AppState>,
    id: String,
    index: String,
) -> AppResult<serde_json::Value> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::delete_index(&conn, &index).await
}

#[tauri::command]
pub async fn es_delete_doc(
    state: State<'_, AppState>,
    id: String,
    index: String,
    doc_id: String,
) -> AppResult<serde_json::Value> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::delete_doc(&conn, &index, &doc_id).await
}

/// 通用 REST（_cat / _cluster / _aliases 这类）留给「高级」用
#[tauri::command]
pub async fn es_request(
    state: State<'_, AppState>,
    id: String,
    method: String,
    path: String,
    body: String,
) -> AppResult<serde_json::Value> {
    let conn = state.manager.get(&id)?;
    crate::driver::elasticsearch_driver::ElasticsearchDriver::request(&conn, &method, &path, &body)
        .await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<TableInfo>> {
    IntrospectionService::list_tables(&state.manager, &id, &database).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    IntrospectionService::list_columns(&state.manager, &id, &database, &table).await
}

#[tauri::command]
pub async fn database_schema(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<TableSchema>> {
    IntrospectionService::database_schema(&state.manager, &id, &database).await
}

/// 解析一个 PowerDesigner `.pdm` 文件（离线文件，不需要数据库连接）。
/// 同时登记到 `pdm_files`，给文件分配一个稳定 id（字段笔记按它关联）。
#[derive(serde::Serialize)]
pub struct OpenedPdmFile {
    pub id: String,
    #[serde(flatten)]
    pub file: crate::service::pdm::PdmFile,
}

#[tauri::command]
pub async fn read_pdm(state: State<'_, AppState>, path: String) -> AppResult<OpenedPdmFile> {
    let file = crate::service::pdm::read_pdm(std::path::Path::new(&path))?;
    let id = state
        .pdm_files
        .ensure(&file.path, &file.file_name, &file.model_name)
        .await?;
    Ok(OpenedPdmFile { id, file })
}

/// 最近打开过的 PDM 文件（来自本地库，文件已不存在的会被跳过）
#[tauri::command]
pub async fn list_pdm_files(state: State<'_, AppState>) -> AppResult<Vec<PdmFileRecord>> {
    state.pdm_files.list().await
}

/// 一个 PDM 文件下所有字段笔记（一次拉全，用来在字段上标「有笔记」）
#[tauri::command]
pub async fn list_pdm_notes(state: State<'_, AppState>, pdm_id: String) -> AppResult<Vec<PdmNote>> {
    state.pdm_notes.list(&pdm_id).await
}

/// 保存字段笔记；content 为空白等价于删除
#[tauri::command]
pub async fn save_pdm_note(
    state: State<'_, AppState>,
    pdm_id: String,
    database: String,
    table: String,
    column: String,
    content: String,
) -> AppResult<()> {
    state
        .pdm_notes
        .save(&pdm_id, &database, &table, &column, &content)
        .await
}

#[tauri::command]
pub async fn delete_pdm_note(
    state: State<'_, AppState>,
    pdm_id: String,
    database: String,
    table: String,
    column: String,
) -> AppResult<()> {
    state.pdm_notes.delete(&pdm_id, &database, &table, &column).await
}

/// 读一条通用小配置（模型对比的确认状态等）
#[tauri::command]
pub async fn get_app_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    state.settings.get(&key).await
}

/// 写一条通用小配置；`value` 传 null 表示删除
#[tauri::command]
pub async fn set_app_setting(
    state: State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> AppResult<()> {
    state.settings.set(&key, value.as_deref()).await
}

/// ER 图（物理模型）用的整库结构快照：表 + 字段 + 主键 + 真实外键
#[tauri::command]
pub async fn schema_graph(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<crate::domain::SchemaGraph> {
    IntrospectionService::schema_graph(&state.manager, &id, &database).await
}

#[tauri::command]
pub async fn table_ddl(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<String> {
    IntrospectionService::table_ddl(&state.manager, &id, &database, &table).await
}

#[tauri::command]
pub async fn apply_changes(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    changes: Vec<Change>,
) -> AppResult<usize> {
    crate::service::MutationService::apply_changes(&state.manager, &id, &database, &table, &changes).await
}

#[tauri::command]
pub fn preview_changes(
    database: String,
    table: String,
    changes: Vec<Change>,
    flavor: Option<String>,
) -> Vec<String> {
    let dialect = match flavor.as_deref() {
        Some("sqlite") => crate::driver::Dialect::Sqlite,
        Some("postgres") => crate::driver::Dialect::Postgres,
        Some("oracle") => crate::driver::Dialect::Oracle,
        _ => crate::driver::Dialect::Mysql,
    };
    crate::driver::build_change_statements(dialect, &database, &table, &changes)
        .iter()
        .map(crate::driver::render_statement)
        .collect()
}

#[tauri::command]
pub async fn run_sql(
    state: State<'_, AppState>,
    id: String,
    database: Option<String>,
    sql: String,
) -> AppResult<ResultSet> {
    QueryService::run_sql(&state.manager, &id, database.as_deref(), &sql).await
}

/// 执行计划。Oracle 要两步（EXPLAIN PLAN + DBMS_XPLAN），其余引擎就是加个 EXPLAIN 前缀。
#[tauri::command]
pub async fn explain_plan(
    state: State<'_, AppState>,
    id: String,
    database: Option<String>,
    sql: String,
) -> AppResult<ResultSet> {
    let conn = state.manager.get(&id)?;
    match conn {
        crate::driver::DbConnection::Oracle(_) => {
            crate::driver::oracle::OracleDriver::explain(&conn, database.as_deref(), &sql).await
        }
        crate::driver::DbConnection::Sqlite(_) => {
            crate::driver::query(&conn, database.as_deref(), &format!("EXPLAIN QUERY PLAN {sql}"), 200)
                .await
        }
        _ => crate::driver::query(&conn, database.as_deref(), &format!("EXPLAIN {sql}"), 200).await,
    }
}

#[tauri::command]
pub async fn browse_table(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    page: u64,
    page_size: u64,
    filters: Vec<FilterSpec>,
    order_by: Option<String>,
    order_dir: Option<String>,
) -> AppResult<BrowsedTable> {
    QueryService::browse_table(
        &state.manager,
        &id,
        &database,
        &table,
        Page { limit: page_size, offset: page },
        page_size,
        filters,
        order_by,
        order_dir,
    )
    .await
}

#[tauri::command]
pub async fn export_table(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    filters: Vec<FilterSpec>,
    order_by: Option<String>,
    order_dir: Option<String>,
    format: String,
    path: String,
) -> AppResult<u64> {
    crate::service::io::export_table(
        &state.manager,
        &id,
        &database,
        &table,
        &filters,
        order_by.as_deref(),
        order_dir.as_deref(),
        ExportFormat::parse(&format)?,
        &path,
    )
    .await
}

/// 新建数据库（MySQL 系）/ schema（PostgreSQL）。
#[tauri::command]
pub async fn create_database(
    state: State<'_, AppState>,
    id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> AppResult<()> {
    MutationService::create_database(
        &state.manager,
        &id,
        &name,
        charset.as_deref(),
        collation.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn import_csv_preview(path: String) -> AppResult<ImportPreview> {
    crate::service::io::import_csv_preview(&path)
}

#[tauri::command]
pub async fn import_csv(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    path: String,
    delimiter: String,
    has_header: bool,
    mapping: Vec<ImportColumn>,
    skip_errors: bool,
) -> AppResult<ImportReport> {
    crate::service::io::import_csv(
        &state.manager,
        &id,
        &database,
        &table,
        &path,
        &delimiter,
        has_header,
        &mapping,
        skip_errors,
    )
    .await
}

#[tauri::command]
pub async fn run_sql_file(
    state: State<'_, AppState>,
    id: String,
    database: String,
    path: String,
) -> AppResult<SqlFileReport> {
    crate::service::io::run_sql_file(&state.manager, &id, &database, &path).await
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> AppResult<()> {
    std::fs::write(path, content).map_err(crate::error::AppError::from)
}

/// 二进制落盘（导出 ER 图的 PNG 用）
#[tauri::command]
pub fn write_bytes_file(path: String, bytes: Vec<u8>) -> AppResult<()> {
    std::fs::write(path, bytes).map_err(crate::error::AppError::from)
}

#[tauri::command]
pub async fn foreign_keys(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<crate::domain::ForeignKeyRef>> {
    IntrospectionService::foreign_keys(&state.manager, &id, &database, &table).await
}

#[derive(serde::Serialize)]
pub struct AppInfo {
    pub version: String,
    pub config_dir: String,
}

#[tauri::command]
pub async fn table_comment(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<String> {
    IntrospectionService::table_comment(&state.manager, &id, &database, &table).await
}

#[tauri::command]
pub async fn indexes(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<crate::domain::IndexInfo>> {
    IntrospectionService::indexes(&state.manager, &id, &database, &table).await
}

#[tauri::command]
pub async fn list_ai_providers(state: State<'_, AppState>) -> AppResult<AiProviders> {
    crate::service::ai::list(&state.ai).await
}

#[tauri::command]
pub async fn save_ai_provider(
    state: State<'_, AppState>,
    provider: AiProvider,
) -> AppResult<AiProviders> {
    crate::service::ai::save_provider(&state.ai, provider).await
}

#[tauri::command]
pub async fn delete_ai_provider(state: State<'_, AppState>, id: String) -> AppResult<AiProviders> {
    crate::service::ai::delete_provider(&state.ai, &id).await
}

#[tauri::command]
pub async fn set_default_ai_provider(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<AiProviders> {
    crate::service::ai::set_default(&state.ai, &id).await
}

#[tauri::command]
pub async fn list_ai_conversations(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<Vec<Conversation>> {
    state.ai_chat.list_conversations(connection_id.as_deref()).await
}

#[tauri::command]
pub async fn create_ai_conversation(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    title: String,
) -> AppResult<Conversation> {
    state.ai_chat.create_conversation(connection_id.as_deref(), &title).await
}

#[tauri::command]
pub async fn delete_ai_conversation(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.ai_chat.delete_conversation(&id).await
}

#[tauri::command]
pub async fn ai_conversation_messages(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<crate::storage::ChatMessage>> {
    state.ai_chat.messages(&id).await
}

#[derive(Clone, serde::Serialize)]
struct AiChunk {
    conversation_id: String,
    delta: String,
}

#[derive(Clone, serde::Serialize)]
struct AiReasoning {
    conversation_id: String,
    delta: String,
}

#[derive(Clone, serde::Serialize)]
struct AiDone {
    conversation_id: String,
    content: String,
    reasoning: String,
}

#[derive(Clone, serde::Serialize)]
struct AiFailed {
    conversation_id: String,
    message: String,
}

/// 跑一轮对话。回复通过 `ai://chunk` 增量推给前端，结束时发 `ai://done`。
#[tauri::command]
pub async fn ai_chat_send(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    connection_id: Option<String>,
    database: Option<String>,
    table: Option<String>,
    message: String,
) -> AppResult<()> {
    use tauri::Emitter;

    // 前置检查：没有可用的供应商就不发起请求，让前端去引导设置
    let provider = crate::service::ai::default_ready(&state.ai.load().await?)?;

    let database = database.unwrap_or_default();
    let system = crate::service::ai_chat::build_context(
        &state.manager,
        connection_id.as_deref(),
        &database,
        table.as_deref(),
        &message,
    )
    .await;

    let history_raw: Vec<(String, String)> = state
        .ai_chat
        .messages(&conversation_id)
        .await?
        .into_iter()
        .map(|m| (m.role, m.content))
        .collect();
    let first_turn = history_raw.is_empty();

    state.ai_chat.append(&conversation_id, "user", &message).await?;
    if first_turn {
        let title: String = message.chars().take(20).collect();
        state.ai_chat.touch(&conversation_id, Some(&title)).await?;
    } else {
        state.ai_chat.touch(&conversation_id, None).await?;
    }

    let ctx = crate::service::ai_chat::ChatContext {
        base_url: provider.base_url.clone(),
        token: provider.token.clone(),
        model: provider.default_model.clone(),
        system,
        history: crate::service::ai_chat::trim_history(&history_raw),
    };

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .chat_cancels
        .lock()
        .unwrap()
        .insert(conversation_id.clone(), cancel.clone());

    let app_for_delta = app.clone();
    let conv = conversation_id.clone();
    let result = crate::service::ai_chat::chat_stream(&ctx, &message, cancel, move |kind, delta| {
        // 正文和思考过程分成两种事件推：抽屉里思考过程只占一行，可展开
        match kind {
            crate::service::ai_chat::StreamKind::Text => {
                let _ = app_for_delta.emit(
                    "ai://chunk",
                    AiChunk { conversation_id: conv.clone(), delta: delta.to_string() },
                );
            }
            crate::service::ai_chat::StreamKind::Reasoning => {
                let _ = app_for_delta.emit(
                    "ai://reasoning",
                    AiReasoning { conversation_id: conv.clone(), delta: delta.to_string() },
                );
            }
        }
    })
    .await;

    state.chat_cancels.lock().unwrap().remove(&conversation_id);

    match result {
        Ok(out) => {
            let text = out.text;
            if !text.is_empty() {
                // 思考过程跟着这条回复一起存，重新打开会话还能展开看
                state
                    .ai_chat
                    .append_with_reasoning(&conversation_id, "assistant", &text, &out.reasoning)
                    .await?;
            }
            let _ = app.emit(
                "ai://done",
                AiDone {
                    conversation_id: conversation_id.clone(),
                    content: text,
                    reasoning: out.reasoning,
                },
            );
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "ai://error",
                AiFailed { conversation_id: conversation_id.clone(), message: e.to_string() },
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub fn ai_chat_cancel(state: State<'_, AppState>, conversation_id: String) {
    if let Some(flag) = state.chat_cancels.lock().unwrap().get(&conversation_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn list_sql_history(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<Vec<SqlHistoryItem>> {
    state.sql_library.history(&connection_id, &database).await
}

#[tauri::command]
pub async fn push_sql_history(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    sql: String,
) -> AppResult<()> {
    state.sql_library.push_history(&connection_id, &database, &sql).await
}

#[tauri::command]
pub async fn list_saved_sql(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<Vec<SqlSavedItem>> {
    state.sql_library.saved(&connection_id, &database).await
}

#[tauri::command]
pub async fn save_sql(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    name: String,
    sql: String,
) -> AppResult<SqlSavedItem> {
    state.sql_library.save_sql(&connection_id, &database, &name, &sql).await
}

#[tauri::command]
pub async fn delete_saved_sql(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    state.sql_library.delete_saved(id).await
}

#[tauri::command]
pub async fn sync_ai_models(provider: AiProvider) -> AppResult<Vec<String>> {
    crate::service::ai::sync_models(&provider).await
}

#[derive(Clone, serde::Serialize)]
struct PlanChunk {
    request_id: String,
    /// text = 正文，reasoning = 思考过程
    kind: &'static str,
    delta: String,
}

#[derive(Clone, serde::Serialize)]
struct PlanDone {
    request_id: String,
    text: String,
    reasoning: String,
}

#[derive(Clone, serde::Serialize)]
struct PlanFailed {
    request_id: String,
    message: String,
}

/// 分析一条 SQL 的执行计划（「执行计划」标签页里自动跑）。
/// 流式推送：正文和思考过程分别发 `ai://plan-chunk`，不落会话历史。
#[tauri::command]
pub async fn ai_analyze_plan_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    connection_id: Option<String>,
    database: Option<String>,
    table: Option<String>,
    sql: Option<String>,
    plan: String,
) -> AppResult<()> {
    use tauri::Emitter;

    let provider = crate::service::ai::default_ready(&state.ai.load().await?)?;
    let database = database.unwrap_or_default();
    // 表结构（DDL + 字段）塞进 system，模型才提得出「加哪个索引」
    let system = crate::service::ai_chat::build_context(
        &state.manager,
        connection_id.as_deref(),
        &database,
        table.as_deref(),
        &plan,
    )
    .await;
    let ctx = crate::service::ai_chat::ChatContext {
        base_url: provider.base_url.clone(),
        token: provider.token.clone(),
        model: provider.default_model.clone(),
        system,
        history: Vec::new(),
    };
    let prompt = crate::service::ai_chat::plan_analysis_prompt(sql.as_deref(), &plan);

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .chat_cancels
        .lock()
        .unwrap()
        .insert(request_id.clone(), cancel.clone());

    let app_for_delta = app.clone();
    let req = request_id.clone();
    let result = crate::service::ai_chat::chat_stream(&ctx, &prompt, cancel, move |kind, delta| {
        let _ = app_for_delta.emit(
            "ai://plan-chunk",
            PlanChunk {
                request_id: req.clone(),
                kind: match kind {
                    crate::service::ai_chat::StreamKind::Text => "text",
                    crate::service::ai_chat::StreamKind::Reasoning => "reasoning",
                },
                delta: delta.to_string(),
            },
        );
    })
    .await;

    state.chat_cancels.lock().unwrap().remove(&request_id);

    match result {
        Ok(out) => {
            let _ = app.emit(
                "ai://plan-done",
                PlanDone {
                    request_id: request_id.clone(),
                    text: out.text,
                    reasoning: out.reasoning,
                },
            );
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "ai://plan-error",
                PlanFailed { request_id: request_id.clone(), message: e.to_string() },
            );
            Err(e)
        }
    }
}

/// 停止一次还在跑的请求（AI 对话和「执行计划」分析共用一张取消表）
#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, id: String) {
    if let Some(flag) = state.chat_cancels.lock().unwrap().get(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}
#[tauri::command]
pub async fn test_ai_provider(
    provider: AiProvider,
) -> AppResult<crate::service::ai::AiTestResult> {
    crate::service::ai::test_provider(&provider).await
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    let dir = crate::storage::config_dir();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        config_dir: dir.to_string_lossy().to_string(),
    }
}
