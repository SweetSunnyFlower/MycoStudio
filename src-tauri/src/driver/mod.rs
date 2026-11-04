use crate::domain::{ConnectionConfig, ResultSet};
use crate::error::AppResult;

pub mod elasticsearch_driver;
pub mod mysql;
pub mod mongodb_driver;
pub mod oracle;
pub mod postgres;
pub mod redis_driver;
pub mod sqlite;

/// 驱动报不出声明类型时 sqlx 会给回字面量 "NULL"（SQLite 对表达式列就是这样）。
/// 直接透传到界面会被读成「这一列的值是 NULL」，所以收敛成空串，让界面不显示类型。
pub fn declared_type_name(name: &str) -> String {
    if name.eq_ignore_ascii_case("null") {
        String::new()
    } else {
        name.to_string()
    }
}

#[derive(Clone)]
pub enum DbConnection {
    Mysql(sqlx::MySqlPool),
    Postgres(sqlx::PgPool),
    Sqlite(sqlx::SqlitePool),
    /// Oracle 走官方 thin 驱动（阻塞式），一个 Arc 里就一条会话
    Oracle(std::sync::Arc<oracle::OracleConn>),
    /// Redis 走官方 client（原生 tokio 异步），db 号已经烤进连接 URL
    Redis(redis::aio::ConnectionManager),
    /// MongoDB 走官方 driver（原生 tokio 异步），Client 是连接池句柄，可克隆
    MongoDb(mongodb::Client),
    /// Elasticsearch 走 REST（reqwest），一个 arc 里是 client + base url + 认证
    Elasticsearch(std::sync::Arc<elasticsearch_driver::EsConn>),
}

impl DbConnection {
    pub fn as_mysql(&self) -> &sqlx::MySqlPool {
        match self {
            DbConnection::Mysql(p) => p,
            DbConnection::Sqlite(_) | DbConnection::Postgres(_) | DbConnection::Oracle(_)
            | DbConnection::Redis(_) | DbConnection::MongoDb(_)
            | DbConnection::Elasticsearch(_) => {
                panic!("connection is not mysql")
            }
        }
    }

    pub fn as_postgres(&self) -> &sqlx::PgPool {
        match self {
            DbConnection::Postgres(p) => p,
            DbConnection::Mysql(_) | DbConnection::Sqlite(_) | DbConnection::Oracle(_)
            | DbConnection::Redis(_) | DbConnection::MongoDb(_)
            | DbConnection::Elasticsearch(_) => {
                panic!("connection is not postgres")
            }
        }
    }

    pub fn as_sqlite(&self) -> &sqlx::SqlitePool {
        match self {
            DbConnection::Sqlite(p) => p,
            DbConnection::Mysql(_) | DbConnection::Postgres(_) | DbConnection::Oracle(_)
            | DbConnection::Redis(_) | DbConnection::MongoDb(_)
            | DbConnection::Elasticsearch(_) => {
                panic!("connection is not sqlite")
            }
        }
    }

    pub fn as_oracle(&self) -> &std::sync::Arc<oracle::OracleConn> {
        match self {
            DbConnection::Oracle(c) => c,
            _ => panic!("connection is not oracle"),
        }
    }

    pub fn as_redis(&self) -> &redis::aio::ConnectionManager {
        match self {
            DbConnection::Redis(m) => m,
            _ => panic!("connection is not redis"),
        }
    }

    pub fn as_mongo(&self) -> &mongodb::Client {
        match self {
            DbConnection::MongoDb(c) => c,
            _ => panic!("connection is not mongodb"),
        }
    }

    pub fn as_es(&self) -> &elasticsearch_driver::EsConn {
        match self {
            DbConnection::Elasticsearch(c) => c,
            _ => panic!("connection is not elasticsearch"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Page {
    pub limit: u64,
    pub offset: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TableInfo {
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub raw_type: String,
    /// 列的默认值表达式；`None` 表示没有默认值。
    pub default_value: Option<String>,
    /// 是否由数据库自动生成（MySQL AUTO_INCREMENT / SQLite INTEGER PRIMARY KEY）。
    pub auto_increment: bool,
    /// 列注释（MySQL COLUMN_COMMENT；SQLite 无注释，恒为空串）。
    pub comment: String,
}

#[allow(async_fn_in_trait)]
pub trait RelationalDriver: Send + Sync {
    async fn connect(config: &ConnectionConfig, password: &str) -> AppResult<DbConnection>;
    async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>>;
    async fn list_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableInfo>>;
    async fn list_columns(conn: &DbConnection, database: &str, table: &str)
        -> AppResult<Vec<ColumnInfo>>;
    async fn query(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        max_rows: usize,
    ) -> AppResult<ResultSet>;
    async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64>;
}

pub trait NonRelationalDriver: Send + Sync {}

pub async fn connect(
    config: &ConnectionConfig,
    password: &str,
    ssh_password: Option<String>,
) -> AppResult<DbConnection> {
    match config.flavor {
        crate::domain::DbFlavor::Sqlite => sqlite::SqliteDriver::connect(config, password).await,
        crate::domain::DbFlavor::Postgres => {
            postgres::PostgresDriver::connect(config, password, ssh_password).await
        }
        crate::domain::DbFlavor::Oracle => {
            oracle::OracleDriver::connect(config, password, ssh_password).await
        }
        crate::domain::DbFlavor::Redis => {
            redis_driver::RedisDriver::connect(config, password, ssh_password).await
        }
        crate::domain::DbFlavor::MongoDb => {
            mongodb_driver::MongoDbDriver::connect(config, password, ssh_password).await
        }
        crate::domain::DbFlavor::Elasticsearch => {
            elasticsearch_driver::ElasticsearchDriver::connect(config, password, ssh_password).await
        }
        _ => mysql::MysqlDriver::connect(config, password, ssh_password).await,
    }
}

pub async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::list_databases(conn).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::list_databases(conn).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::list_databases(conn).await,
        // Redis 没有「数据库名」，只有 0..N 的逻辑库序号；把序号转成字符串喂给前端
        DbConnection::Redis(_) => {
            let count = redis_driver::RedisDriver::database_count(conn).await;
            Ok((0..count).map(|i| i.to_string()).collect())
        }
        DbConnection::MongoDb(_) => mongodb_driver::MongoDbDriver::list_databases(conn).await,
        DbConnection::Elasticsearch(_) => {
            elasticsearch_driver::ElasticsearchDriver::list_databases(conn).await
        }
        _ => mysql::MysqlDriver::list_databases(conn).await,
    }
}

pub async fn list_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableInfo>> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::list_tables(conn, database).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::list_tables(conn, database).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::list_tables(conn, database).await,
        _ => mysql::MysqlDriver::list_tables(conn, database).await,
    }
}

pub async fn list_columns(
    conn: &DbConnection,
    database: &str,
    table: &str,
) -> AppResult<Vec<ColumnInfo>> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::list_columns(conn, database, table).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::list_columns(conn, database, table).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::list_columns(conn, database, table).await,
        _ => mysql::MysqlDriver::list_columns(conn, database, table).await,
    }
}

pub async fn query(
    conn: &DbConnection,
    database: Option<&str>,
    sql: &str,
    max_rows: usize,
) -> AppResult<ResultSet> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::query(conn, database, sql, max_rows).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::query(conn, database, sql, max_rows).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::query(conn, database, sql, max_rows).await,
        _ => mysql::MysqlDriver::query(conn, database, sql, max_rows).await,
    }
}

pub async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::count(conn, sql).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::count(conn, sql).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::count(conn, sql).await,
        _ => mysql::MysqlDriver::count(conn, sql).await,
    }
}

pub async fn query_bound(
    conn: &DbConnection,
    database: Option<&str>,
    sql: &str,
    params: Vec<String>,
    max_rows: usize,
) -> AppResult<ResultSet> {
    match conn {
        DbConnection::Sqlite(_) => {
            sqlite::SqliteDriver::query_bound(conn, database, sql, params, max_rows).await
        }
        DbConnection::Postgres(_) => {
            postgres::PostgresDriver::query_bound(conn, database, sql, params, max_rows).await
        }
        DbConnection::Oracle(_) => {
            oracle::OracleDriver::query_bound(conn, database, sql, params, max_rows).await
        }
        _ => mysql::MysqlDriver::query_bound(conn, database, sql, params, max_rows).await,
    }
}

pub async fn count_bound(
    conn: &DbConnection,
    database: Option<&str>,
    sql: &str,
    params: Vec<String>,
) -> AppResult<i64> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::count_bound(conn, database, sql, params).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::count_bound(conn, database, sql, params).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::count_bound(conn, database, sql, params).await,
        _ => mysql::MysqlDriver::count_bound(conn, database, sql, params).await,
    }
}

pub async fn schema_tables(
    conn: &DbConnection,
    database: &str,
) -> AppResult<Vec<crate::domain::TableSchema>> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::schema_tables(conn, database).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::schema_tables(conn, database).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::schema_tables(conn, database).await,
        _ => mysql::MysqlDriver::schema_tables(conn, database).await,
    }
}

/// 整库结构快照（ER 图用）：表 + 字段 + 主键 + 真实外键
pub async fn schema_graph(
    conn: &DbConnection,
    database: &str,
) -> AppResult<crate::domain::SchemaGraph> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::schema_graph(conn, database).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::schema_graph(conn, database).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::schema_graph(conn, database).await,
        _ => mysql::MysqlDriver::schema_graph(conn, database).await,
    }
}

pub async fn table_ddl(conn: &DbConnection, database: &str, table: &str) -> AppResult<String> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::table_ddl(conn, database, table).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::table_ddl(conn, database, table).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::table_ddl(conn, database, table).await,
        _ => mysql::MysqlDriver::table_ddl(conn, database, table).await,
    }
}

pub async fn foreign_keys(
    conn: &DbConnection,
    database: &str,
    table: &str,
) -> AppResult<Vec<crate::domain::ForeignKeyRef>> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::foreign_keys(conn, table).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::foreign_keys(conn, database, table).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::foreign_keys(conn, database, table).await,
        _ => mysql::MysqlDriver::foreign_keys(conn, database, table).await,
    }
}

pub async fn indexes(
    conn: &DbConnection,
    database: &str,
    table: &str,
) -> AppResult<Vec<crate::domain::IndexInfo>> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::indexes(conn, table).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::indexes(conn, database, table).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::indexes(conn, database, table).await,
        _ => mysql::MysqlDriver::indexes(conn, database, table).await,
    }
}

pub async fn table_comment(
    conn: &DbConnection,
    database: &str,
    table: &str,
) -> AppResult<String> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::table_comment(conn, table).await,
        DbConnection::Postgres(_) => postgres::PostgresDriver::table_comment(conn, database, table).await,
        DbConnection::Oracle(_) => oracle::OracleDriver::table_comment(conn, database, table).await,
        _ => mysql::MysqlDriver::table_comment(conn, database, table).await,
    }
}

/// 不同引擎的 SQL 方言差异
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Mysql,
    Sqlite,
    Postgres,
    Oracle,
}

impl Dialect {
    /// 空值安全的等值比较：MySQL 用 `<=>`，SQLite 用 `IS`。
    /// 主键/定位列可能为 NULL（无主键表手动选定位列时），普通 `=` 匹配不到 NULL。
    pub fn null_safe_eq(self) -> &'static str {
        match self {
            Dialect::Mysql => "<=>",
            Dialect::Sqlite => "IS",
            Dialect::Postgres => "IS NOT DISTINCT FROM",
            // Oracle 没有现成的空值安全比较运算符，用等价的括号表达式（见 null_safe_eq_clause）
            Dialect::Oracle => "=",
        }
    }

    /// 空值安全的「列 = 占位符」条件。Oracle 不支持 IS NOT DISTINCT FROM，
    /// 用 DECODE（NULL 与 NULL 视为相等）表达；这样占位符只出现一次——
    /// rust-oracledb 的位置绑定是**按占位符出现次数**取值的。
    pub fn null_safe_eq_clause(self, column: &str, ph: &str) -> String {
        match self {
            Dialect::Oracle => format!("DECODE({c}, {p}, 1, 0) = 1", c = column, p = ph),
            _ => format!("{} {} {}", column, self.null_safe_eq(), ph),
        }
    }

    /// 标识符引号：MySQL 用反引号，SQLite / PostgreSQL 用双引号。
    pub fn quote(self, name: &str) -> String {
        match self {
            Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
            Dialect::Sqlite | Dialect::Postgres | Dialect::Oracle => {
                format!("\"{}\"", name.replace('"', "\"\""))
            }
        }
    }

    /// 第 n 个绑定占位符（从 1 开始）。Oracle 用 `:1 :2`，其余引擎交给驱动按位置绑定。
    pub fn placeholder(self, n: usize) -> String {
        match self {
            Dialect::Oracle => format!(":{n}"),
            _ => "?".to_string(),
        }
    }

    /// 分页子句。Oracle 12c+ 才有 OFFSET/FETCH。
    pub fn limit_clause(self, limit: u64, offset: u64) -> String {
        match self {
            Dialect::Oracle => format!(" OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"),
            _ => format!(" LIMIT {limit} OFFSET {offset}"),
        }
    }

    /// 「只取一行」（UPDATE 影响 0 行时用来判断这行是否还存在）
    pub fn limit_one_clause(self) -> &'static str {
        match self {
            Dialect::Oracle => " FETCH FIRST 1 ROWS ONLY",
            _ => " LIMIT 1",
        }
    }
}

/// PG 的 `::cast` 类型名：数组内部名 `_text` 转成 `text[]`，其余原样。
pub fn pg_cast_type(raw_type: &str) -> String {
    if raw_type.starts_with('_') {
        format!("{}[]", &raw_type[1..])
    } else {
        raw_type.to_string()
    }
}

pub struct BuiltStatement {
    pub sql: String,
    pub params: Vec<Option<String>>,
}

/// 各个驱动把自己那份「表 / 字段 / 主键标记」和「外键边」交进来，
/// 这里统一拼成 ER 图数据（顺便把「这一列是不是外键」标上）。
///
/// `columns` 必须按表名有序（各驱动的查询都按表名 + 列序号排过），
/// 因为这里靠「表名变了就开新表」来分组。
pub fn assemble_graph(
    // (表名, 列名, 类型, 可空, 主键, 列注释)
    columns: Vec<(String, String, String, bool, bool, String)>,
    edges: Vec<crate::domain::GraphEdge>,
    table_comments: std::collections::HashMap<String, String>,
) -> crate::domain::SchemaGraph {
    use std::collections::HashSet;
    let fk_columns: HashSet<(String, String)> = edges
        .iter()
        .map(|e| (e.from_table.clone(), e.from_column.clone()))
        .collect();
    let mut tables: Vec<crate::domain::GraphTable> = Vec::new();
    for (table, column, raw_type, nullable, primary_key, comment) in columns {
        let foreign_key = fk_columns.contains(&(table.clone(), column.clone()));
        let col = crate::domain::GraphColumn {
            name: column,
            raw_type,
            nullable,
            primary_key,
            foreign_key,
            comment,
            logical_name: String::new(),
        };
        match tables.last_mut() {
            Some(last) if last.name == table => last.columns.push(col),
            _ => tables.push(crate::domain::GraphTable {
                comment: table_comments.get(&table).cloned().unwrap_or_default(),
                name: table,
                columns: vec![col],
                logical_name: String::new(),
                indexes: Vec::new(),
            }),
        }
    }
    crate::domain::SchemaGraph { tables, edges }
}

pub fn build_change_statements(
    dialect: Dialect,
    database: &str,
    table: &str,
    changes: &[crate::domain::Change],
) -> Vec<BuiltStatement> {
    changes
        .iter()
        .filter_map(|c| build_change_statement(dialect, database, table, c))
        .collect()
}

/// 单条 Change → SQL 语句（空 pk / 空 values 的跳过）
pub fn build_change_statement(
    dialect: Dialect,
    database: &str,
    table: &str,
    change: &crate::domain::Change,
) -> Option<BuiltStatement> {
    use crate::domain::Change;
    let table_ref = format!("{}.{}", dialect.quote(database), dialect.quote(table));
    match change {
        Change::Insert { values } => {
            if values.is_empty() {
                return None;
            }
            let cols: Vec<String> = values.iter().map(|v| dialect.quote(&v.column)).collect();
            let ph: Vec<String> = (1..=values.len()).map(|i| dialect.placeholder(i)).collect();
            Some(BuiltStatement {
                sql: format!("INSERT INTO {} ({}) VALUES ({})", table_ref, cols.join(", "), ph.join(", ")),
                params: values.iter().map(|v| v.value.clone()).collect(),
            })
        }
        Change::Update { pk, values, original } => {
            if pk.is_empty() || values.is_empty() {
                return None;
            }
            let mut n = 0usize;
            let set: Vec<String> = values
                .iter()
                .map(|v| {
                    n += 1;
                    format!("{} = {}", dialect.quote(&v.column), dialect.placeholder(n))
                })
                .collect();
            let mut wh: Vec<String> = pk
                .iter()
                .map(|v| {
                    n += 1;
                    dialect.null_safe_eq_clause(&dialect.quote(&v.column), &dialect.placeholder(n))
                })
                .collect();
            // 原始值也进 WHERE：原始值对不上说明这行已经被别人改过
            wh.extend(original.iter().map(|v| {
                n += 1;
                dialect.null_safe_eq_clause(&dialect.quote(&v.column), &dialect.placeholder(n))
            }));
            let mut params: Vec<Option<String>> = values.iter().map(|v| v.value.clone()).collect();
            params.extend(pk.iter().map(|v| v.value.clone()));
            params.extend(original.iter().map(|v| v.value.clone()));
            Some(BuiltStatement {
                sql: format!("UPDATE {} SET {} WHERE {}", table_ref, set.join(", "), wh.join(" AND ")),
                params,
            })
        }
        Change::Delete { pk } => {
            if pk.is_empty() {
                return None;
            }
            let wh: Vec<String> = pk
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    dialect.null_safe_eq_clause(&dialect.quote(&v.column), &dialect.placeholder(i + 1))
                })
                .collect();
            Some(BuiltStatement {
                sql: format!("DELETE FROM {} WHERE {}", table_ref, wh.join(" AND ")),
                params: pk.iter().map(|v| v.value.clone()).collect(),
            })
        }
    }
}

/// UPDATE 影响 0 行时，用它区分「值其实没变」和「行被别人改了」。
/// 用原始值做 WHERE：还能匹配到 = 没变（安全）；匹配不到 = 冲突。
pub fn build_existence_check(
    dialect: Dialect,
    database: &str,
    table: &str,
    change: &crate::domain::Change,
) -> Option<BuiltStatement> {
    use crate::domain::Change;
    let (pk, original) = match change {
        Change::Update { pk, original, .. } => (pk, original),
        _ => return None,
    };
    if pk.is_empty() {
        return None;
    }
    let mut wh: Vec<String> = pk
        .iter()
        .enumerate()
        .map(|(i, v)| {
            dialect.null_safe_eq_clause(&dialect.quote(&v.column), &dialect.placeholder(i + 1))
        })
        .collect();
    let base = pk.len();
    wh.extend(original.iter().enumerate().map(|(i, v)| {
        dialect.null_safe_eq_clause(&dialect.quote(&v.column), &dialect.placeholder(base + i + 1))
    }));
    let mut params: Vec<Option<String>> = pk.iter().map(|v| v.value.clone()).collect();
    params.extend(original.iter().map(|v| v.value.clone()));
    Some(BuiltStatement {
        sql: format!(
            "SELECT 1 FROM {}.{} WHERE {}{}",
            dialect.quote(database),
            dialect.quote(table),
            wh.join(" AND "),
            dialect.limit_one_clause()
        ),
        params,
    })
}

pub async fn apply_changes(
    conn: &DbConnection,
    database: &str,
    table: &str,
    changes: &[crate::domain::Change],
) -> AppResult<usize> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::apply_changes(conn, database, table, changes).await,
        DbConnection::Postgres(_) => {
            postgres::PostgresDriver::apply_changes(conn, database, table, changes).await
        }
        DbConnection::Oracle(_) => {
            oracle::OracleDriver::apply_changes(conn, database, table, changes).await
        }
        _ => mysql::MysqlDriver::apply_changes(conn, database, table, changes).await,
    }
}

/// 把「第几条改动出错」编码进错误信息，前端据此定位到具体的行
pub fn change_failed(index: usize, detail: &str) -> crate::error::AppError {
    crate::error::AppError::Message(format!("第 {} 条改动{detail}", index + 1))
}

/// 按连接类型选方言
pub fn dialect_of(conn: &DbConnection) -> Dialect {
    match conn {
        DbConnection::Sqlite(_) => Dialect::Sqlite,
        DbConnection::Postgres(_) => Dialect::Postgres,
        DbConnection::Oracle(_) => Dialect::Oracle,
        _ => Dialect::Mysql,
    }
}

/// 把一条构造好的语句渲染成可读 SQL（把参数内联为字面量，仅供预览展示）。
pub fn render_statement(stmt: &BuiltStatement) -> String {
    let mut out = String::new();
    // 占位符有两种：`?`（MySQL / SQLite / PG）和 `:n`（Oracle）
    let chars: Vec<char> = stmt.sql.chars().collect();
    let mut i = 0usize;
    let mut next = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        let mut digits = String::new();
        if ch == '?' {
            i += 1;
            next += 1;
        } else if ch == ':' && chars.get(i + 1).map(|c| c.is_ascii_digit()).unwrap_or(false) {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_ascii_digit() {
                digits.push(chars[j]);
                j += 1;
            }
            i = j;
            next = digits.parse::<usize>().unwrap_or(next + 1);
        } else {
            out.push(ch);
            i += 1;
            continue;
        }
        match stmt.params.get(next.wrapping_sub(1)) {
            None => out.push('?'),
            Some(None) => out.push_str("NULL"),
            Some(Some(s)) => {
                out.push('\'');
                out.push_str(&s.replace('\\', "\\\\").replace('\'', "''"));
                out.push('\'');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Change, ColumnValue};

    #[test]
    fn builds_insert_update_delete() {
        let changes = vec![
            Change::Insert {
                values: vec![
                    ColumnValue { column: "id".into(), value: Some("9".into()) },
                    ColumnValue { column: "name".into(), value: None },
                ],
            },
            Change::Update {
                pk: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
                values: vec![ColumnValue { column: "name".into(), value: Some("x".into()) }],
                original: vec![ColumnValue { column: "name".into(), value: Some("a".into()) }],
            },
            Change::Delete {
                pk: vec![ColumnValue { column: "id".into(), value: Some("2".into()) }],
            },
        ];
        let stmts = build_change_statements(Dialect::Mysql, "db", "t", &changes);
        assert_eq!(stmts[0].sql, "INSERT INTO `db`.`t` (`id`, `name`) VALUES (?, ?)");
        assert_eq!(stmts[0].params, vec![Some("9".into()), None]);
        // 原始值进 WHERE，原始值为 NULL 时用空值安全比较
        assert_eq!(stmts[1].sql, "UPDATE `db`.`t` SET `name` = ? WHERE `id` <=> ? AND `name` <=> ?");
        assert_eq!(
            stmts[1].params,
            vec![Some("x".into()), Some("1".into()), Some("a".into())]
        );
        assert_eq!(stmts[2].sql, "DELETE FROM `db`.`t` WHERE `id` <=> ?");
    }

    /// ER 图数据拼装：按表分组 + 标出外键列（没有外键约束的列不会被标）
    #[test]
    fn assembles_schema_graph() {
        let columns = vec![
            ("CHILD".to_string(), "ID".to_string(), "NUMBER".to_string(), false, true, String::new()),
            ("CHILD".to_string(), "PARENT_ID".to_string(), "NUMBER".to_string(), true, false, "父表 ID".to_string()),
            ("CHILD".to_string(), "NOTE".to_string(), "VARCHAR2".to_string(), true, false, String::new()),
            ("PARENT".to_string(), "ID".to_string(), "NUMBER".to_string(), false, true, String::new()),
        ];
        let table_comments = std::collections::HashMap::from([("PARENT".to_string(), "父表".to_string())]);
        let edges = vec![crate::domain::GraphEdge {
            from_table: "CHILD".into(),
            from_column: "PARENT_ID".into(),
            to_table: "PARENT".into(),
            to_column: "ID".into(),
            name: String::new(),
        }];
        let graph = assemble_graph(columns, edges, table_comments);
        assert_eq!(graph.tables.len(), 2);
        assert_eq!(graph.tables[0].name, "CHILD");
        assert_eq!(graph.tables[0].columns.len(), 3);
        assert!(graph.tables[0].columns[0].primary_key);
        assert!(!graph.tables[0].columns[0].foreign_key);
        assert!(graph.tables[0].columns[1].foreign_key, "PARENT_ID 应该是外键列");
        assert!(!graph.tables[0].columns[2].foreign_key, "没有约束的列不能被标成外键");
        assert_eq!(graph.edges.len(), 1);
        // 注释也要带进图数据（模型视图和导出都要用）
        assert_eq!(graph.tables[0].columns[1].comment, "父表 ID");
        assert_eq!(graph.tables[1].comment, "父表");
    }

    /// Oracle：位置绑定 `:n` + 空值安全比较要展开成括号表达式
    #[test]
    fn builds_oracle_statements() {
        let changes = vec![
            Change::Insert {
                values: vec![
                    ColumnValue { column: "id".into(), value: Some("9".into()) },
                    ColumnValue { column: "name".into(), value: None },
                ],
            },
            Change::Update {
                pk: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
                values: vec![ColumnValue { column: "name".into(), value: Some("x".into()) }],
                original: vec![ColumnValue { column: "name".into(), value: Some("a".into()) }],
            },
        ];
        let stmts = build_change_statements(Dialect::Oracle, "SCOTT", "EMP", &changes);
        assert_eq!(stmts[0].sql, "INSERT INTO \"SCOTT\".\"EMP\" (\"id\", \"name\") VALUES (:1, :2)");
        assert_eq!(
            stmts[1].sql,
            "UPDATE \"SCOTT\".\"EMP\" SET \"name\" = :1 WHERE DECODE(\"id\", :2, 1, 0) = 1 \
             AND DECODE(\"name\", :3, 1, 0) = 1"
        );

        // 预览要把 `:n` 也内联成字面量
        let rendered = render_statement(&stmts[1]);
        assert!(rendered.contains("SET \"name\" = 'x'"), "{rendered}");
        assert!(rendered.contains("DECODE(\"id\", '1', 1, 0) = 1"), "{rendered}");
        assert!(rendered.contains("DECODE(\"name\", 'a', 1, 0) = 1"), "{rendered}");
        assert!(!rendered.contains(":1"), "{rendered}");

        // 存在性检查用 FETCH FIRST 1 ROWS ONLY
        let check = build_existence_check(Dialect::Oracle, "SCOTT", "EMP", &changes[1]).unwrap();
        assert!(check.sql.ends_with("FETCH FIRST 1 ROWS ONLY"), "{}", check.sql);
    }

    #[test]
    fn skips_pk_less_update_and_delete() {
        let changes = vec![
            Change::Update {
                pk: vec![],
                values: vec![ColumnValue { column: "a".into(), value: Some("1".into()) }],
                original: vec![],
            },
            Change::Delete { pk: vec![] },
        ];
        assert!(build_change_statements(Dialect::Mysql, "db", "t", &changes).is_empty());
    }

    #[test]
    fn sqlite_uses_is_for_null_safe_compare() {
        let changes = vec![Change::Update {
            pk: vec![ColumnValue { column: "k".into(), value: None }],
            values: vec![ColumnValue { column: "v".into(), value: Some("1".into()) }],
            original: vec![ColumnValue { column: "v".into(), value: None }],
        }];
        let stmts = build_change_statements(Dialect::Sqlite, "main", "t", &changes);
        assert_eq!(stmts[0].sql, "UPDATE \"main\".\"t\" SET \"v\" = ? WHERE \"k\" IS ? AND \"v\" IS ?");
        assert_eq!(stmts[0].params, vec![Some("1".into()), None, None]);
    }

    #[test]
    fn postgres_uses_dollar_placeholders_and_not_distinct() {
        let changes = vec![Change::Update {
            pk: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
            values: vec![ColumnValue { column: "name".into(), value: Some("x".into()) }],
            original: vec![ColumnValue { column: "name".into(), value: None }],
        }];
        let stmts = build_change_statements(Dialect::Postgres, "public", "t", &changes);
        // 构造层统一用 `?`，由 postgres 驱动在真正执行时重写成 $1/$2…
        assert_eq!(
            stmts[0].sql,
            "UPDATE \"public\".\"t\" SET \"name\" = ? WHERE \"id\" IS NOT DISTINCT FROM ? AND \"name\" IS NOT DISTINCT FROM ?"
        );
    }

    #[test]
    fn escapes_backtick_identifiers() {
        let changes = vec![Change::Delete {
            pk: vec![ColumnValue { column: "we`ird".into(), value: Some("1".into()) }],
        }];
        let stmts = build_change_statements(Dialect::Mysql, "db", "t", &changes);
        assert_eq!(stmts[0].sql, "DELETE FROM `db`.`t` WHERE `we``ird` <=> ?");
    }

    #[test]
    fn renders_statement_for_preview() {
        let changes = vec![Change::Update {
            pk: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
            values: vec![ColumnValue { column: "name".into(), value: Some("a'b".into()) }],
            original: vec![ColumnValue { column: "name".into(), value: Some("old".into()) }],
        }];
        let stmts = build_change_statements(Dialect::Mysql, "db", "t", &changes);
        assert_eq!(
            render_statement(&stmts[0]),
            "UPDATE `db`.`t` SET `name` = 'a''b' WHERE `id` <=> '1' AND `name` <=> 'old'"
        );
    }
}
