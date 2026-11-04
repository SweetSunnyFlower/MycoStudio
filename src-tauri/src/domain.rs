use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Decimal(String),
    Str(String),
    Bytes(Vec<u8>),
    Date(String),
    Time(String),
    DateTime(String),
    Json(String),
}

impl Value {
    /// 导出/展示用文本。NULL 用空串，二进制转十六进制。
    pub fn to_text(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
            Value::Int(i) => i.to_string(),
            Value::UInt(u) => u.to_string(),
            Value::Float(f) => f.to_string(),
            Value::Decimal(s)
            | Value::Str(s)
            | Value::Date(s)
            | Value::Time(s)
            | Value::DateTime(s)
            | Value::Json(s) => s.clone(),
            Value::Bytes(b) => b.iter().map(|x| format!("{x:02x}")).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultSet {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbFlavor {
    Mysql,
    MariaDb,
    TiDb,
    Sqlite,
    Postgres,
    Oracle,
    Redis,
    MongoDb,
    Elasticsearch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub database: Option<String>,
    pub flavor: DbFlavor,
    pub file_path: Option<String>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    #[serde(default)]
    pub ssl_ca: Option<String>,
    #[serde(default)]
    pub ssl_cert: Option<String>,
    #[serde(default)]
    pub ssl_key: Option<String>,
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_auth_method: Option<String>,
    #[serde(default)]
    pub ssh_private_key_path: Option<String>,
    /// Oracle 连接方式：service（服务名，默认）/ sid
    #[serde(default)]
    pub oracle_conn_type: Option<String>,
    /// Oracle 特权认证：None / SYSDBA / SYSOPER
    #[serde(default)]
    pub oracle_role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterSpec {
    pub column: String,
    pub operator: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<String>,
}

/// ER 图（物理模型）里的一个字段
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphColumn {
    pub name: String,
    pub raw_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    /// 这一列是不是某个外键的「子侧」（有外键约束才算，不做推断）
    pub foreign_key: bool,
    /// 列注释（库里读的、PDM 文件里读的都可能带）
    #[serde(default)]
    pub comment: String,
    /// PowerDesigner 里的逻辑名（`a:Name`，中文团队一般写中文名）；库里没有这个概念，为空
    #[serde(default)]
    pub logical_name: String,
}

/// 索引（PDM 文件里会带；从数据库读的模型暂时不填）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphIndex {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

/// ER 图里的一张表
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphTable {
    pub name: String,
    pub columns: Vec<GraphColumn>,
    #[serde(default)]
    pub comment: String,
    /// PowerDesigner 里的表逻辑名（`a:Name`）
    #[serde(default)]
    pub logical_name: String,
    #[serde(default)]
    pub indexes: Vec<GraphIndex>,
}

/// 一条外键连线：from（子表列）→ to（父表列）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
    /// 约束名（PDM 里的 Reference 名字；从数据库读时是外键名，可能为空）
    #[serde(default)]
    pub name: String,
}

/// 整库结构快照：画 ER 图一次拉完，避免每张表各查一遍
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaGraph {
    pub tables: Vec<GraphTable>,
    pub edges: Vec<GraphEdge>,
}

/// Redis 里一个 key 的完整快照（给 Redis 工作台用，和关系型的「表/行」是两套模型）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisEntry {
    pub key: String,
    /// string / hash / list / set / zset / stream
    pub key_type: String,
    /// 值统一转成 JSON：string→字符串、hash→对象、list/set→数组、zset→[{member,score}]
    pub value: serde_json::Value,
    /// -1 = 永不过期，-2 = 不存在
    pub ttl: i64,
    /// 元素个数（string 是字节数）
    pub size: usize,
}

/// Redis SCAN 的一页结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisScanResult {
    pub keys: Vec<String>,
    pub next_cursor: u64,
}

/// MongoDB 一个集合的查询结果：文档是 schema-less 的 JSON，列名由前端按文档顶层字段并集算。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MongoQueryResult {
    /// 文档列表（Bson → 宽松扩展 JSON，ObjectId 会变成 {"$oid":"..."}）
    pub documents: Vec<serde_json::Value>,
    /// 命中总数（和 documents 的「本次分页数量」是两回事）
    pub total: u64,
    pub elapsed_ms: u64,
}

/// Elasticsearch 一次 `_search` 的结果：每行是 `_source` 的字段 + `_id` / `_index` / `_score`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EsSearchResult {
    pub documents: Vec<serde_json::Value>,
    /// 命中总数（ES 7+ 在 hits.total.value，6 在 hits.total）
    pub total: u64,
    /// ES 自己报的 took（毫秒）
    pub took_ms: u64,
    pub elapsed_ms: u64,
}

/// ES 集群信息（连接测试 / 头部展示用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EsClusterInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyRef {
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    /// 索引包含的列，按索引内顺序排列
    pub columns: Vec<String>,
    pub unique: bool,
    /// 是否主键索引（MySQL PRIMARY / SQLite origin=pk / PG indisprimary）
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnValue {
    pub column: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Insert { values: Vec<ColumnValue> },
    Update {
        pk: Vec<ColumnValue>,
        values: Vec<ColumnValue>,
        /// 被修改列的原始值：用于校验「这行是不是已经被别人改过」
        #[serde(default)]
        original: Vec<ColumnValue>,
    },
    Delete { pk: Vec<ColumnValue> },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_roundtrips_through_json() {
        let v = Value::Int(42);
        let s = serde_json::to_string(&v).unwrap();
        let back: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn null_is_serialized_with_type_tag() {
        let s = serde_json::to_string(&Value::Null).unwrap();
        assert_eq!(s, r#"{"type":"null"}"#);
    }

    #[test]
    fn flavor_uses_lowercase_names() {
        assert_eq!(serde_json::to_string(&DbFlavor::MariaDb).unwrap(), r#""mariadb""#);
        assert_eq!(serde_json::to_string(&DbFlavor::TiDb).unwrap(), r#""tidb""#);
        assert_eq!(serde_json::to_string(&DbFlavor::Mysql).unwrap(), r#""mysql""#);
    }

    #[test]
    fn value_tag_names_match_frontend() {
        assert_eq!(serde_json::to_string(&Value::UInt(1)).unwrap(), r#"{"type":"uint","value":1}"#);
        assert_eq!(
            serde_json::to_string(&Value::DateTime("2026-01-01".into())).unwrap(),
            r#"{"type":"datetime","value":"2026-01-01"}"#
        );
    }

    #[test]
    fn connection_config_never_holds_password_field() {
        let cfg = ConnectionConfig {
            id: "c1".into(),
            name: "local".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            username: "root".into(),
            database: None,
            flavor: DbFlavor::Mysql,
            file_path: None,
            ssl_mode: None,
            ssl_ca: None,
            ssl_cert: None,
            ssl_key: None,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_user: String::new(),
            ssh_auth_method: None,
            ssh_private_key_path: None,
            oracle_conn_type: None,
            oracle_role: None,
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(!s.contains("password"));
    }
}
