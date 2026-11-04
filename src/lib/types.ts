export type DbFlavor =
  | "mysql"
  | "mariadb"
  | "tidb"
  | "sqlite"
  | "postgres"
  | "oracle"
  | "redis"
  | "mongodb"
  | "elasticsearch";

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  database: string | null;
  flavor: DbFlavor;
  file_path: string | null;
  ssl_mode?: string | null;
  ssl_ca?: string | null;
  ssl_cert?: string | null;
  ssl_key?: string | null;
  ssh_enabled?: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_auth_method?: string | null;
  ssh_private_key_path?: string | null;
  /** Oracle 连接方式：service（服务名，默认）/ sid */
  oracle_conn_type?: string | null;
  /** Oracle 特权认证：SYSDBA / SYSOPER */
  oracle_role?: string | null;
}

export type Value =
  | { type: "null" }
  // 仅前端暂存态使用：新增行里用户没填的字段，交给数据库默认值
  | { type: "default" }
  | { type: "bool"; value: boolean }
  | { type: "int"; value: number }
  | { type: "uint"; value: number }
  | { type: "float"; value: number }
  | { type: "decimal"; value: string }
  | { type: "str"; value: string }
  | { type: "bytes"; value: number[] }
  | { type: "date"; value: string }
  | { type: "time"; value: string }
  | { type: "datetime"; value: string }
  | { type: "json"; value: string };

export interface Column { name: string; type_name: string; }

/** ER 图（物理模型）数据：只反映库里真实的外键约束，不做任何推断 */
export interface GraphColumn {
  name: string;
  raw_type: string;
  nullable: boolean;
  primary_key: boolean;
  /** 这一列是不是某个外键的子侧 */
  foreign_key: boolean;
  /** 列注释（PDM 文件或库里读到的） */
  comment?: string;
  /** PowerDesigner 里的逻辑名（a:Name，中文团队一般写中文名）；库里没有这个概念 */
  logical_name?: string;
}

export interface GraphIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface GraphTable {
  name: string;
  columns: GraphColumn[];
  comment?: string;
  /** PowerDesigner 里的表逻辑名（a:Name） */
  logical_name?: string;
  indexes?: GraphIndex[];
}

export interface GraphEdge {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  /** 约束名（PDM 里的 Reference 名 / 库里的外键名） */
  name?: string;
}

export interface SchemaGraph {
  tables: GraphTable[];
  edges: GraphEdge[];
}

/** PowerDesigner .pdm 文件解析结果 */
export interface PdmFile {
  /** 打开时在本地库登记的稳定 id（字段笔记按它关联） */
  id: string;
  path: string;
  file_name: string;
  model_name: string;
  graph: SchemaGraph;
}

/** PDM 字段笔记（内容为 markdown） */
export interface PdmNote {
  database: string;
  table: string;
  column: string;
  content: string;
}

/** 本地库里登记过的 PDM 文件（「最近打开」列表用） */
export interface PdmFileRecord {
  id: string;
  path: string;
  file_name: string;
  model_name: string;
  last_opened_at: number;
}
export interface ResultSet { columns: Column[]; rows: Value[][]; truncated: boolean; elapsed_ms: number; }
export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  raw_type: string;
  /** 列默认值表达式，null 表示没有默认值 */
  default_value: string | null;
  /** 数据库自动生成（MySQL AUTO_INCREMENT / SQLite INTEGER PRIMARY KEY） */
  auto_increment: boolean;
  /** 列注释（SQLite 恒为空串） */
  comment: string;
}
export interface TableInfo { name: string; }
export interface BrowsedTable { columns: Column[]; rows: Value[][]; total: number; elapsed_ms: number; }

export interface Filter { column: string; operator: string; value: string; }

export interface ImportColumn { file_column: string; table_column: string; }
export interface ImportPreview {
  delimiter: string;
  has_header: boolean;
  columns: string[];
  sample: string[][];
}
export interface ImportReport { imported: number; failed: number; errors: string[]; }
export interface SqlFileReport { executed: number; total: number; }
export interface ForeignKeyRef { column: string; ref_table: string; ref_column: string; }

export interface IndexInfo { name: string; columns: string[]; unique: boolean; primary: boolean; }

export interface TableSchema { name: string; columns: string[]; }

/** Redis 里一个 key 的完整快照（非关系型，和关系型的「表/行」是两套模型） */
export interface RedisEntry {
  key: string;
  /** string / hash / list / set / zset / stream */
  key_type: string;
  /** 值统一转成 JSON：string→字符串、hash→对象、list/set→数组、zset→[{member,score}] */
  value: unknown;
  /** -1 = 永不过期，-2 = 不存在 */
  ttl: number;
  /** 元素个数（string 是字节数） */
  size: number;
}

/** Redis SCAN 的一页结果 */
export interface RedisScanResult {
  keys: string[];
  next_cursor: number;
}

/** MongoDB 一个集合的查询结果（文档是 schema-less 的 JSON） */
export interface MongoQueryResult {
  documents: unknown[];
  /** 命中总数（和本次分页数量是两回事） */
  total: number;
  elapsed_ms: number;
}

/** Elasticsearch 一次 _search 的结果 */
export interface EsSearchResult {
  documents: unknown[];
  total: number;
  took_ms: number;
  elapsed_ms: number;
}

export interface EsClusterInfo {
  name: string;
  version: string;
}

/** AI 供应商（OpenAI 兼容接口）。token 明文存本地配置文件。 */
export interface AiProvider {
  id: string;
  name: string;
  base_url: string;
  token: string;
  default_model: string;
  models: string[];
}

export interface AiProviders {
  default_id: string | null;
  providers: AiProvider[];
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  models: string[];
}

/** AI 会话（存本地 SQLite，按连接分组） */
export interface Conversation {
  id: string;
  connection_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessage {
  id: number;
  role: string;
  content: string;
  /** 模型的思考过程（DeepSeek 这类会给）；空串表示没有 */
  reasoning: string;
  created_at: number;
}

/** SQL 执行历史（存本地库 sql_history 表） */
export interface SqlHistoryItem {
  id: number;
  sql: string;
  created_at: number;
}

/** SQL 收藏（存本地库 sql_saved 表） */
export interface SqlSavedItem {
  id: number;
  name: string;
  sql: string;
  created_at: number;
}

export interface ColumnValue { column: string; value: string | null; }

export type Change =
  | { kind: "insert"; values: ColumnValue[] }
  /** original = 被修改列的原始值，用于校验「这行是否已被别人改过」 */
  | { kind: "update"; pk: ColumnValue[]; values: ColumnValue[]; original: ColumnValue[] }
  | { kind: "delete"; pk: ColumnValue[] };

export function valueToDisplay(v: Value): string {
  if (v.type === "null") return "NULL";
  if (v.type === "default") return "(默认)";
  if (v.type === "bytes") return `<binary ${v.value.length}B>`;
  return String((v as { value: unknown }).value);
}

// 供编辑用的纯文本（NULL / 二进制返回空串）
export function valueToText(v: Value): string {
  if (v.type === "null" || v.type === "default" || v.type === "bytes") return "";
  return String((v as { value: unknown }).value);
}
