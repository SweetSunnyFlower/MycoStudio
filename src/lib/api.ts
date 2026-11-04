import { invoke } from "@tauri-apps/api/core";
import type {
  AiProvider,
  AiProviders,
  AiTestResult,
  ChatMessage,
  Conversation,
  BrowsedTable,
  Change,
  ColumnInfo,
  ConnectionConfig,
  EsClusterInfo,
  EsSearchResult,
  Filter,
  ImportColumn,
  ImportPreview,
  ImportReport,
  ForeignKeyRef,
  IndexInfo,
  MongoQueryResult,
  PdmFileRecord,
  PdmNote,
  PdmFile,
  RedisEntry,
  RedisScanResult,
  ResultSet,
  SchemaGraph,
  SqlFileReport,
  TableInfo,
  TableSchema,
  SqlHistoryItem,
  SqlSavedItem,
} from "./types";

export const api = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, password?: string, sshPassword?: string) =>
    invoke<ConnectionConfig>("save_connection", {
      config,
      password: password ?? null,
      sshPassword: sshPassword ?? null,
    }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (config: ConnectionConfig, password?: string, sshPassword?: string) =>
    invoke<void>("test_connection", {
      config,
      password: password ?? null,
      sshPassword: sshPassword ?? null,
    }),
  testSavedConnection: (id: string) => invoke<void>("test_saved_connection", { id }),
  connect: (id: string) => invoke<void>("connect", { id }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  listDatabases: (id: string) => invoke<string[]>("list_databases", { id }),
  redisScan: (id: string, prefix: string, cursor: number, count: number) =>
    invoke<RedisScanResult>("redis_scan", { id, prefix, cursor, count }),
  redisEntry: (id: string, key: string) => invoke<RedisEntry>("redis_entry", { id, key }),
  redisSetString: (id: string, key: string, value: string, ttlSeconds: number | null) =>
    invoke<void>("redis_set_string", { id, key, value, ttlSeconds }),
  redisDelete: (id: string, key: string) => invoke<void>("redis_delete", { id, key }),
  redisExpire: (id: string, key: string, seconds: number) =>
    invoke<void>("redis_expire", { id, key, seconds }),
  redisExec: (id: string, args: string[]) => invoke<unknown>("redis_exec", { id, args }),
  redisSelectDb: (id: string, db: string) => invoke<void>("redis_select_db", { id, db }),
  mongodbListCollections: (id: string, database: string) =>
    invoke<string[]>("mongodb_list_collections", { id, database }),
  mongodbFind: (
    id: string,
    database: string,
    collection: string,
    filter: string,
    sort: string,
    skip: number,
    limit: number,
  ) =>
    invoke<MongoQueryResult>("mongodb_find", {
      id,
      database,
      collection,
      filter,
      sort,
      skip,
      limit,
    }),
  mongodbInsertOne: (id: string, database: string, collection: string, document: string) =>
    invoke<void>("mongodb_insert_one", { id, database, collection, document }),
  mongodbReplaceOne: (
    id: string,
    database: string,
    collection: string,
    filter: string,
    replacement: string,
  ) => invoke<number>("mongodb_replace_one", { id, database, collection, filter, replacement }),
  mongodbDeleteOne: (id: string, database: string, collection: string, filter: string) =>
    invoke<number>("mongodb_delete_one", { id, database, collection, filter }),
  esClusterInfo: (id: string) => invoke<EsClusterInfo>("es_cluster_info", { id }),
  esIndices: (id: string) => invoke<string[]>("es_indices", { id }),
  esFields: (id: string, index: string) => invoke<string[]>("es_fields", { id, index }),
  esSearch: (id: string, index: string, body: string) =>
    invoke<EsSearchResult>("es_search", { id, index, body }),
  esIndexDoc: (id: string, index: string, docId: string | null, document: string) =>
    invoke<unknown>("es_index_doc", { id, index, docId, document }),
  esCreateIndex: (id: string, index: string, body: string) =>
    invoke<unknown>("es_create_index", { id, index, body }),
  esDeleteIndex: (id: string, index: string) =>
    invoke<unknown>("es_delete_index", { id, index }),
  esDeleteDoc: (id: string, index: string, docId: string) =>
    invoke<unknown>("es_delete_doc", { id, index, docId }),
  esRequest: (id: string, method: string, path: string, body: string) =>
    invoke<unknown>("es_request", { id, method, path, body }),
  listTables: (id: string, database: string) => invoke<TableInfo[]>("list_tables", { id, database }),
  listColumns: (id: string, database: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { id, database, table }),
  databaseSchema: (id: string, database: string) =>
    invoke<TableSchema[]>("database_schema", { id, database }),
  /** ER 图（物理模型）：整库表 + 字段 + 真实外键，一次拉完 */
  schemaGraph: (id: string, database: string) =>
    invoke<SchemaGraph>("schema_graph", { id, database }),
  /** 解析 PowerDesigner .pdm（离线文件，不需要连接） */
  readPdm: (path: string) => invoke<PdmFile>("read_pdm", { path }),
  /** 最近打开过的 PDM 文件（本地库里有登记、且文件仍然存在的） */
  listPdmFiles: () => invoke<PdmFileRecord[]>("list_pdm_files"),
  /** 一个 PDM 文件下所有字段笔记 */
  listPdmNotes: (pdmId: string) => invoke<PdmNote[]>("list_pdm_notes", { pdmId }),
  /** 保存字段笔记（markdown）；content 为空白等价于删除 */
  savePdmNote: (pdmId: string, database: string, table: string, column: string, content: string) =>
    invoke<void>("save_pdm_note", { pdmId, database, table, column, content }),
  deletePdmNote: (pdmId: string, database: string, table: string, column: string) =>
    invoke<void>("delete_pdm_note", { pdmId, database, table, column }),
  tableDdl: (id: string, database: string, table: string) =>
    invoke<string>("table_ddl", { id, database, table }),
  applyChanges: (id: string, database: string, table: string, changes: Change[]) =>
    invoke<number>("apply_changes", { id, database, table, changes }),
  previewChanges: (database: string, table: string, changes: Change[], flavor?: string) =>
    invoke<string[]>("preview_changes", { database, table, changes, flavor: flavor ?? null }),
  runSql: (id: string, database: string | null, sql: string) =>
    invoke<ResultSet>("run_sql", { id, database, sql }),
  /** 执行计划：Oracle 在后台要跑 EXPLAIN PLAN + DBMS_XPLAN 两步，其余引擎加前缀 */
  explainPlan: (id: string, database: string | null, sql: string) =>
    invoke<ResultSet>("explain_plan", { id, database, sql }),
  browseTable: (
    id: string,
    database: string,
    table: string,
    page: number,
    pageSize: number,
    orderBy: string | null,
    orderDir: string | null,
    filters: Filter[],
  ) => invoke<BrowsedTable>("browse_table", { id, database, table, page, pageSize, orderBy, orderDir, filters }),
  exportTable: (
    id: string,
    database: string,
    table: string,
    filters: Filter[],
    orderBy: string | null,
    orderDir: string | null,
    format: "csv" | "json" | "sql",
    path: string,
  ) =>
    invoke<number>("export_table", {
      id,
      database,
      table,
      filters,
      orderBy,
      orderDir,
      format,
      path,
    }),
  createDatabase: (id: string, name: string, charset?: string, collation?: string) =>
    invoke<void>("create_database", {
      id,
      name,
      charset: charset ?? null,
      collation: collation ?? null,
    }),
  importCsvPreview: (path: string) => invoke<ImportPreview>("import_csv_preview", { path }),
  importCsv: (
    id: string,
    database: string,
    table: string,
    path: string,
    delimiter: string,
    hasHeader: boolean,
    mapping: ImportColumn[],
    skipErrors: boolean,
  ) =>
    invoke<ImportReport>("import_csv", {
      id,
      database,
      table,
      path,
      delimiter,
      hasHeader,
      mapping,
      skipErrors,
    }),
  runSqlFile: (id: string, database: string, path: string) =>
    invoke<SqlFileReport>("run_sql_file", { id, database, path }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),
  /** 二进制落盘（导出 ER 图的 PNG） */
  writeBytesFile: (path: string, bytes: number[]) =>
    invoke<void>("write_bytes_file", { path, bytes }),
  /** 通用小配置（模型对比的确认状态等）；value 传 null 表示删除 */
  getAppSetting: (key: string) => invoke<string | null>("get_app_setting", { key }),
  setAppSetting: (key: string, value: string | null) =>
    invoke<void>("set_app_setting", { key, value }),
  foreignKeys: (id: string, database: string, table: string) =>
    invoke<ForeignKeyRef[]>("foreign_keys", { id, database, table }),
  indexes: (id: string, database: string, table: string) =>
    invoke<IndexInfo[]>("indexes", { id, database, table }),
  appInfo: () => invoke<{ version: string; config_dir: string }>("app_info"),
  tableComment: (id: string, database: string, table: string) =>
    invoke<string>("table_comment", { id, database, table }),
  listSqlHistory: (connectionId: string, database: string) =>
    invoke<SqlHistoryItem[]>("list_sql_history", { connectionId, database }),
  pushSqlHistory: (connectionId: string, database: string, sql: string) =>
    invoke<void>("push_sql_history", { connectionId, database, sql }),
  listSavedSql: (connectionId: string, database: string) =>
    invoke<SqlSavedItem[]>("list_saved_sql", { connectionId, database }),
  saveSql: (connectionId: string, database: string, name: string, sql: string) =>
    invoke<SqlSavedItem>("save_sql", { connectionId, database, name, sql }),
  deleteSavedSql: (id: number) => invoke<void>("delete_saved_sql", { id }),
  listAiProviders: () => invoke<AiProviders>("list_ai_providers"),
  saveAiProvider: (provider: AiProvider) => invoke<AiProviders>("save_ai_provider", { provider }),
  deleteAiProvider: (id: string) => invoke<AiProviders>("delete_ai_provider", { id }),
  setDefaultAiProvider: (id: string) => invoke<AiProviders>("set_default_ai_provider", { id }),
  syncAiModels: (provider: AiProvider) => invoke<string[]>("sync_ai_models", { provider }),
  testAiProvider: (provider: AiProvider) => invoke<AiTestResult>("test_ai_provider", { provider }),
  /** 「执行计划」标签页里自动跑的分析：流式推送 ai://plan-chunk，不进会话 */
  aiAnalyzePlanStream: (p: {
    requestId: string;
    connectionId: string | null;
    database: string | null;
    table: string | null;
    sql: string | null;
    plan: string;
  }) => invoke<void>("ai_analyze_plan_stream", p),
  /** 停止一次还在跑的 AI 请求（对话 / 执行计划分析共用） */
  aiCancel: (id: string) => invoke<void>("ai_cancel", { id }),
  listAiConversations: (connectionId: string | null) =>
    invoke<Conversation[]>("list_ai_conversations", { connectionId }),
  createAiConversation: (connectionId: string | null, title: string) =>
    invoke<Conversation>("create_ai_conversation", { connectionId, title }),
  deleteAiConversation: (id: string) => invoke<void>("delete_ai_conversation", { id }),
  aiConversationMessages: (id: string) => invoke<ChatMessage[]>("ai_conversation_messages", { id }),
  aiChatSend: (p: {
    conversationId: string;
    connectionId: string | null;
    database: string | null;
    table: string | null;
    message: string;
  }) => invoke<void>("ai_chat_send", p),
  aiChatCancel: (conversationId: string) => invoke<void>("ai_chat_cancel", { conversationId }),
};
