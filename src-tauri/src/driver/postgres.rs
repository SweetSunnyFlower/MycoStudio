use std::time::Instant;

use futures::StreamExt;
use sqlx::postgres::PgSslMode;
use sqlx::{Column as _, Row as _, TypeInfo as _, ValueRef as _};

use super::{ColumnInfo, DbConnection, Dialect, RelationalDriver, TableInfo};
use crate::domain::{Column, ConnectionConfig, ResultSet, SchemaGraph, TableSchema, Value};
use crate::error::AppResult;

pub struct PostgresDriver;

fn connect_options(config: &ConnectionConfig, password: &str) -> sqlx::postgres::PgConnectOptions {
    let mut opts = sqlx::postgres::PgConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .username(&config.username)
        .password(password);
    if let Some(db) = &config.database {
        opts = opts.database(db);
    }
    if let Some(mode) = config.ssl_mode.as_deref() {
        opts = opts.ssl_mode(match mode {
            "disable" | "disabled" => PgSslMode::Disable,
            "allow" => PgSslMode::Allow,
            "require" | "required" => PgSslMode::Require,
            "verify_ca" => PgSslMode::VerifyCa,
            "verify_identity" | "verify_full" => PgSslMode::VerifyFull,
            _ => PgSslMode::Prefer,
        });
    }
    if let Some(ca) = config.ssl_ca.as_deref() {
        opts = opts.ssl_root_cert(ca);
    }
    if let Some(cert) = config.ssl_cert.as_deref() {
        opts = opts.ssl_client_cert(cert);
    }
    if let Some(key) = config.ssl_key.as_deref() {
        opts = opts.ssl_client_key(key);
    }
    opts
}

/// 把 `$1 / $2 / ...` 占位符换成转义后的字面量。
///
/// 这么做是为了走「简单查询协议」：扩展协议下 sqlx 对大多数类型返回二进制，
/// 而它的 `as_str()` 只是把字节当 UTF-8 读，numeric / uuid / timestamptz /
/// 数组等都会变成乱码；简单协议下一律返回文本，就没有这个问题。
/// 自己生成的 SQL 里没有字面 `$n`，所以逐个替换是安全的；字符串按标准
/// 字符串字面量处理（反斜杠是普通字符，只需把单引号翻倍）。
fn inline_params(sql: &str, params: &[String]) -> String {
    let mut out = String::with_capacity(sql.len() + params.len() * 8);
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            out.push(ch);
            continue;
        }
        let mut digits = String::new();
        while let Some(c) = chars.peek() {
            if c.is_ascii_digit() {
                digits.push(*c);
                chars.next();
            } else {
                break;
            }
        }
        match digits.parse::<usize>() {
            Ok(i) if i >= 1 && i <= params.len() => {
                out.push('\'');
                out.push_str(&params[i - 1].replace('\'', "''"));
                out.push('\'');
            }
            _ => {
                out.push('$');
                out.push_str(&digits);
            }
        }
    }
    out
}

fn quote(name: &str) -> String {
    Dialect::Postgres.quote(name)
}

/// 解析 PostgreSQL 的 numeric 二进制格式：base-10000，大端。
///
/// 扩展协议下 numeric 是二进制返回的，`as_str()` 取不出来，
/// 直接当字节用会导出一串乱码（导出 / 分页浏览走的就是这条路）。
fn decode_pg_numeric(b: &[u8]) -> Option<String> {
    if b.len() < 8 {
        return None;
    }
    let ndigits = i16::from_be_bytes([b[0], b[1]]);
    let weight = i16::from_be_bytes([b[2], b[3]]);
    let sign = u16::from_be_bytes([b[4], b[5]]);
    let dscale = i16::from_be_bytes([b[6], b[7]]);
    if ndigits < 0 || dscale < 0 || b.len() < 8 + ndigits as usize * 2 {
        return None;
    }
    match sign {
        0xC000 => return Some("NaN".to_string()),
        0xD000 => return Some("Infinity".to_string()),
        0xF000 => return Some("-Infinity".to_string()),
        _ => {}
    }

    let digits: Vec<u32> = (0..ndigits as usize)
        .map(|i| u16::from_be_bytes([b[8 + i * 2], b[9 + i * 2]]) as u32)
        .collect();

    let mut out = String::new();
    if sign == 0x4000 {
        out.push('-');
    }
    // 整数部分：指数 weight..0 的那几组
    if weight < 0 {
        out.push('0');
    } else {
        for i in 0..=weight as usize {
            let d = *digits.get(i).unwrap_or(&0);
            if i == 0 {
                out.push_str(&d.to_string());
            } else {
                out.push_str(&format!("{d:04}"));
            }
        }
    }
    // 小数部分：按 dscale 补足位数
    if dscale > 0 {
        let groups = (dscale as usize + 3) / 4;
        let mut frac = String::new();
        for k in 0..groups {
            let idx = weight as i32 + 1 + k as i32;
            let d = if idx >= 0 { *digits.get(idx as usize).unwrap_or(&0) } else { 0 };
            frac.push_str(&format!("{d:04}"));
        }
        frac.truncate(dscale as usize);
        while frac.len() < dscale as usize {
            frac.push('0');
        }
        out.push('.');
        out.push_str(&frac);
    }
    Some(out)
}

/// 扩展协议下少数类型是二进制格式，按类型手工解成文本。
fn pg_binary_to_text(ty: &str, bytes: &[u8]) -> Option<String> {
    match ty {
        // jsonb 二进制 = 1 字节版本号（当前恒为 1）+ UTF-8 文本
        "JSONB" => match bytes.split_first() {
            Some((1, rest)) => String::from_utf8(rest.to_vec()).ok(),
            _ => None,
        },
        "JSON" => String::from_utf8(bytes.to_vec()).ok(),
        "NUMERIC" => decode_pg_numeric(bytes),
        _ => None,
    }
}

/// 取值的文本表示。大多数类型在扩展协议下就是文本，取不到再按已知的二进制格式解。
fn text_of(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
    let raw = row.try_get_raw(i).ok()?;
    if raw.is_null() {
        return None;
    }
    if let Ok(s) = raw.as_str() {
        return Some(s.to_string());
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    let bytes = raw.as_bytes().ok()?;
    pg_binary_to_text(&ty, bytes)
}

fn value_from_row(row: &sqlx::postgres::PgRow, i: usize) -> sqlx::Result<Value> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    let value = match ty.as_str() {
        "BOOL" => row.try_get::<bool, _>(i).map(Value::Bool).ok(),
        "INT2" | "INT4" => row.try_get::<i32, _>(i).map(|v| Value::Int(v as i64)).ok(),
        "INT8" => row.try_get::<i64, _>(i).map(Value::Int).ok(),
        "FLOAT4" => row.try_get::<f32, _>(i).map(|v| Value::Float(v as f64)).ok(),
        "FLOAT8" => row.try_get::<f64, _>(i).map(Value::Float).ok(),
        "DATE" => row.try_get::<chrono::NaiveDate, _>(i).map(|v| Value::Date(v.to_string())).ok(),
        "TIME" => row.try_get::<chrono::NaiveTime, _>(i).map(|v| Value::Time(v.to_string())).ok(),
        "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(i)
            .map(|v| Value::DateTime(v.to_string()))
            .ok(),
        "BYTEA" => row.try_get::<Vec<u8>, _>(i).map(Value::Bytes).ok(),
        "NUMERIC" | "MONEY" => text_of(row, i).map(Value::Decimal),
        "JSON" | "JSONB" => text_of(row, i).map(Value::Json),
        "TEXT" | "VARCHAR" | "BPCHAR" | "CHAR" | "NAME" => {
            row.try_get::<String, _>(i).map(Value::Str).ok()
        }
        // timestamptz / uuid / 数组 / interval / inet / 枚举 等一律原样当文本，不丢信息
        _ => text_of(row, i).map(Value::Str),
    };
    if let Some(v) = value {
        return Ok(v);
    }
    if let Ok(s) = raw.as_str() {
        return Ok(Value::Str(s.to_string()));
    }
    if let Ok(b) = raw.as_bytes() {
        return Ok(Value::Bytes(b.to_vec()));
    }
    Ok(Value::Null)
}

fn columns_of(row: &sqlx::postgres::PgRow) -> Vec<Column> {
    row.columns()
        .iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: crate::driver::declared_type_name(c.type_info().name()),
        })
        .collect()
}

/// 归一化 information_schema 的 data_type，前端 fieldKind 按它选控件
fn normalize_type(data_type: &str) -> String {
    match data_type {
        "character varying" => "varchar".to_string(),
        "character" => "char".to_string(),
        "timestamp without time zone" => "timestamp".to_string(),
        "timestamp with time zone" => "timestamptz".to_string(),
        "time without time zone" => "time".to_string(),
        "time with time zone" => "timetz".to_string(),
        "double precision" => "double".to_string(),
        // 前端按这个挑控件：jsonb 要按 JSON 渲染，bytea 要按二进制渲染
        "jsonb" => "json".to_string(),
        "bytea" => "blob".to_string(),
        other => other.to_string(),
    }
}

/// 展示用类型字符串（带长度 / 精度）
fn display_type(
    data_type: &str,
    udt: &str,
    len: Option<i32>,
    prec: Option<i32>,
    scale: Option<i32>,
) -> String {
    match data_type {
        // 数组在 information_schema 里是 data_type=ARRAY + udt_name=_text，展示成 text[]
        "ARRAY" => super::pg_cast_type(udt),
        "character varying" => len.map(|n| format!("varchar({n})")).unwrap_or_else(|| "varchar".into()),
        "character" => len.map(|n| format!("char({n})")).unwrap_or_else(|| "char".into()),
        "numeric" => match (prec, scale) {
            (Some(p), Some(s)) => format!("numeric({p},{s})"),
            (Some(p), _) => format!("numeric({p})"),
            _ => "numeric".into(),
        },
        "timestamp without time zone" => "timestamp".into(),
        "timestamp with time zone" => "timestamptz".into(),
        "time without time zone" => "time".into(),
        "time with time zone" => "timetz".into(),
        "double precision" => "double precision".into(),
        _ if udt.starts_with('_') => super::pg_cast_type(udt),
        _ => udt.to_string(),
    }
}

impl RelationalDriver for PostgresDriver {
    async fn connect(config: &ConnectionConfig, password: &str) -> AppResult<DbConnection> {
        PostgresDriver::connect(config, password, None).await
    }

    async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>> {
        PostgresDriver::list_databases(conn).await
    }

    async fn list_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableInfo>> {
        PostgresDriver::list_tables(conn, database).await
    }

    async fn list_columns(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        PostgresDriver::list_columns(conn, database, table).await
    }

    async fn query(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        PostgresDriver::query(conn, database, sql, max_rows).await
    }

    async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64> {
        PostgresDriver::count(conn, sql).await
    }
}

impl PostgresDriver {
    pub async fn connect(
        config: &ConnectionConfig,
        password: &str,
        ssh_password: Option<String>,
    ) -> AppResult<DbConnection> {
        let (host, port) = if config.ssh_enabled {
            let tunnel = crate::ssh_tunnel::start_tunnel(config, &config.host, config.port, ssh_password).await?;
            let port = tunnel.local_port;
            crate::ssh_tunnel::register(&config.id, tunnel);
            ("127.0.0.1".to_string(), port)
        } else {
            (config.host.clone(), config.port)
        };
        let opts = connect_options(config, password).host(&host).port(port);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;
        Ok(DbConnection::Postgres(pool))
    }

    async fn apply_search_path(c: &mut sqlx::PgConnection, database: Option<&str>) -> AppResult<()> {
        if let Some(db) = database {
            if !db.is_empty() {
                let sql = format!("SET search_path TO {}", quote(db));
                sqlx::raw_sql(sqlx::AssertSqlSafe(sql.as_str())).execute(&mut *c).await?;
            }
        }
        Ok(())
    }

    pub async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>> {
        // PostgreSQL 里工作台的「库」对应 schema：list_tables / list_columns / DDL 全都按
        // table_schema 过滤，列数据库名会导致展开后看不到任何表。这里列出 schema。
        let rows = sqlx::query_scalar::<_, String>(
            "select schema_name from information_schema.schemata \
             where schema_name not in ('pg_catalog', 'information_schema') \
               and schema_name not like 'pg_toast%' \
               and schema_name not like 'pg_temp%' \
             order by schema_name",
        )
        .fetch_all(conn.as_postgres())
        .await?;
        Ok(rows)
    }

    pub async fn list_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableInfo>> {
        let rows = sqlx::query(
            "select table_name from information_schema.tables \
             where table_schema = $1 and table_type in ('BASE TABLE','VIEW') order by table_name",
        )
        .bind(database)
        .fetch_all(conn.as_postgres())
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| TableInfo { name: r.try_get::<String, _>(0).unwrap_or_default() })
            .collect())
    }

    pub async fn list_columns(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        let rows = sqlx::query(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, c.udt_name, \
                    c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.is_identity, \
                    COALESCE(col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position), ''), \
                    (EXISTS (SELECT 1 FROM information_schema.table_constraints tc \
                              JOIN information_schema.key_column_usage kcu \
                                ON tc.constraint_schema = kcu.constraint_schema \
                               AND tc.constraint_name = kcu.constraint_name \
                              WHERE tc.constraint_type = 'PRIMARY KEY' \
                                AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name \
                                AND kcu.column_name = c.column_name)) \
             FROM information_schema.columns c \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position",
        )
        .bind(database)
        .bind(table)
        .fetch_all(conn.as_postgres())
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let data_type: String = row.try_get(1)?;
            let default: Option<String> = row.try_get(3)?;
            let udt: String = row.try_get(4)?;
            let len: Option<i32> = row.try_get(5)?;
            let prec: Option<i32> = row.try_get(6)?;
            let scale: Option<i32> = row.try_get(7)?;
            let identity: String = row.try_get(8)?;
            let comment: String = row.try_get(9)?;
            let pk: bool = row.try_get(10)?;
            let auto_increment = identity.eq_ignore_ascii_case("YES")
                || default.as_deref().map(|d| d.contains("nextval")).unwrap_or(false);
            out.push(ColumnInfo {
                name: row.try_get(0)?,
                data_type: normalize_type(&data_type),
                nullable: row.try_get::<String, _>(2)?.eq_ignore_ascii_case("YES"),
                primary_key: pk,
                raw_type: display_type(&data_type, &udt, len, prec, scale),
                default_value: default,
                auto_increment,
                comment,
            });
        }
        Ok(out)
    }

    pub async fn query(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let mut c = conn.as_postgres().acquire().await?;
        Self::apply_search_path(&mut c, database).await?;
        let started = Instant::now();
        let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).fetch(&mut *c);
        let mut rows: Vec<sqlx::postgres::PgRow> = Vec::new();
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            let row = row?;
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
            rows.push(row);
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let columns = rows.first().map(columns_of).unwrap_or_default();
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut values = Vec::with_capacity(row.len());
            for i in 0..row.len() {
                values.push(value_from_row(row, i)?);
            }
            out_rows.push(values);
        }
        Ok(ResultSet { columns, rows: out_rows, truncated, elapsed_ms })
    }

    pub async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64> {
        Ok(sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql)).fetch_one(conn.as_postgres()).await?)
    }

    pub async fn query_bound(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        params: Vec<String>,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let mut c = conn.as_postgres().acquire().await?;
        Self::apply_search_path(&mut c, database).await?;
        // 走简单查询协议（参数内联），这样所有列一律按文本返回
        let sql = inline_params(sql, &params);
        let started = Instant::now();
        let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.as_str())).fetch(&mut *c);
        let mut rows: Vec<sqlx::postgres::PgRow> = Vec::new();
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            let row = row?;
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
            rows.push(row);
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let columns = rows.first().map(columns_of).unwrap_or_default();
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut values = Vec::with_capacity(row.len());
            for i in 0..row.len() {
                values.push(value_from_row(row, i)?);
            }
            out_rows.push(values);
        }
        Ok(ResultSet { columns, rows: out_rows, truncated, elapsed_ms })
    }

    pub async fn count_bound(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        params: Vec<String>,
    ) -> AppResult<i64> {
        let mut c = conn.as_postgres().acquire().await?;
        Self::apply_search_path(&mut c, database).await?;
        let sql = inline_params(sql, &params);
        let mut rows = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.as_str())).fetch(&mut *c);
        let row = rows
            .next()
            .await
            .ok_or_else(|| crate::error::AppError::Message("计数查询没有返回结果".into()))??;
        Ok(row.try_get::<i64, _>(0)?)
    }

    pub async fn schema_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableSchema>> {
        let rows = sqlx::query(
            "select table_name, column_name from information_schema.columns \
             where table_schema = $1 order by table_name, ordinal_position",
        )
        .bind(database)
        .fetch_all(conn.as_postgres())
        .await?;
        let mut out: Vec<TableSchema> = Vec::new();
        for row in rows {
            let table: String = row.try_get(0)?;
            let column: String = row.try_get(1)?;
            if out.last().map(|t| t.name == table).unwrap_or(false) {
                out.last_mut().unwrap().columns.push(column);
            } else {
                out.push(TableSchema { name: table, columns: vec![column] });
            }
        }
        Ok(out)
    }

    /// ER 图用：字段（含主键标记）+ 外键，两条查询搞定，只画真实外键
    pub async fn schema_graph(conn: &DbConnection, database: &str) -> AppResult<SchemaGraph> {
        let cols = sqlx::query(
            "SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable, \
                    (pk.column_name IS NOT NULL), \
                    COALESCE(col_desc.description, ''), COALESCE(tbl_desc.description, '') \
             FROM information_schema.columns c \
             LEFT JOIN ( \
                 SELECT tc.table_schema, tc.table_name, kcu.column_name \
                 FROM information_schema.table_constraints tc \
                 JOIN information_schema.key_column_usage kcu \
                   ON kcu.constraint_schema = tc.constraint_schema \
                  AND kcu.constraint_name = tc.constraint_name \
                 WHERE tc.constraint_type = 'PRIMARY KEY' \
             ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name \
                 AND pk.column_name = c.column_name \
             LEFT JOIN pg_catalog.pg_statio_all_tables st \
                 ON st.schemaname = c.table_schema AND st.relname = c.table_name \
             LEFT JOIN pg_catalog.pg_description col_desc \
                 ON col_desc.objoid = st.relid AND col_desc.objsubid = c.ordinal_position \
             LEFT JOIN pg_catalog.pg_description tbl_desc \
                 ON tbl_desc.objoid = st.relid AND tbl_desc.objsubid = 0 \
             WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position",
        )
        .bind(database)
        .fetch_all(conn.as_postgres())
        .await?;
        let mut columns = Vec::new();
        let mut table_comments: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for r in cols {
            let table: String = r.try_get(0).unwrap_or_default();
            let comment: String = r.try_get(5).unwrap_or_default();
            let table_comment: String = r.try_get(6).unwrap_or_default();
            if !table_comment.is_empty() {
                table_comments.entry(table.clone()).or_insert(table_comment);
            }
            columns.push((
                table,
                r.try_get::<String, _>(1).unwrap_or_default(),
                r.try_get::<String, _>(2).unwrap_or_default(),
                r.try_get::<String, _>(3).map(|s| s.eq_ignore_ascii_case("YES")).unwrap_or(true),
                r.try_get::<bool, _>(4).unwrap_or(false),
                comment,
            ));
        }
        // 复合外键按位置配对，避免跨列笛卡尔积
        let fks = sqlx::query(
            "SELECT fk.table_name, fk.column_name, pk.table_name, pk.column_name \
             FROM information_schema.referential_constraints rc \
             JOIN information_schema.key_column_usage fk \
               ON fk.constraint_schema = rc.constraint_schema \
              AND fk.constraint_name = rc.constraint_name \
             JOIN information_schema.key_column_usage pk \
               ON pk.constraint_schema = rc.unique_constraint_schema \
              AND pk.constraint_name = rc.unique_constraint_name \
              AND pk.ordinal_position = fk.position_in_unique_constraint \
             WHERE fk.table_schema = $1",
        )
        .bind(database)
        .fetch_all(conn.as_postgres())
        .await?;
        let mut edges: Vec<crate::domain::GraphEdge> = Vec::new();
        for row in fks {
            edges.push(crate::domain::GraphEdge {
                from_table: row.try_get(0)?,
                from_column: row.try_get(1)?,
                to_table: row.try_get(2)?,
                to_column: row.try_get(3)?,
                name: String::new(),
            });
        }
        Ok(super::assemble_graph(columns, edges, table_comments))
    }

    pub async fn table_ddl(conn: &DbConnection, database: &str, table: &str) -> AppResult<String> {
        let cols = Self::list_columns(conn, database, table).await?;
        let pks: Vec<String> = cols.iter().filter(|c| c.primary_key).map(|c| c.name.clone()).collect();
        let mut lines: Vec<String> = cols
            .iter()
            .map(|c| {
                let mut def = format!("{} {}", quote(&c.name), c.raw_type);
                if !c.nullable {
                    def.push_str(" NOT NULL");
                }
                if let Some(d) = &c.default_value {
                    def.push_str(&format!(" DEFAULT {d}"));
                }
                def
            })
            .collect();
        if !pks.is_empty() {
            lines.push(format!(
                "PRIMARY KEY ({})",
                pks.iter().map(|p| quote(p)).collect::<Vec<_>>().join(", ")
            ));
        }
        Ok(format!(
            "-- 由元数据重建，索引 / 约束 / 注释可能不完整\nCREATE TABLE {}.{} (\n  {}\n);",
            quote(database),
            quote(table),
            lines.join(",\n  ")
        ))
    }

    pub async fn foreign_keys(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<crate::domain::ForeignKeyRef>> {
        let rows = sqlx::query(
            "SELECT kcu.column_name, ccu.table_name, ccu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name \
             JOIN information_schema.constraint_column_usage ccu \
               ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name \
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2",
        )
        .bind(database)
        .bind(table)
        .fetch_all(conn.as_postgres())
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(crate::domain::ForeignKeyRef {
                column: row.try_get(0)?,
                ref_table: row.try_get(1)?,
                ref_column: row.try_get(2)?,
            });
        }
        Ok(out)
    }

    pub async fn indexes(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<crate::domain::IndexInfo>> {
        let rows = sqlx::query(
            "SELECT i.relname AS index_name, a.attname AS column_name, \
                    ix.indisunique, ix.indisprimary \
             FROM pg_class t \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_index ix ON t.oid = ix.indrelid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY i.relname, array_position(ix.indkey, a.attnum)",
        )
        .bind(database)
        .bind(table)
        .fetch_all(conn.as_postgres())
        .await?;
        let mut out: Vec<crate::domain::IndexInfo> = Vec::new();
        for row in rows {
            let name: String = row.try_get(0)?;
            let column: String = row.try_get(1)?;
            let unique: bool = row.try_get(2)?;
            let primary: bool = row.try_get(3)?;
            if out.last().map(|ix| ix.name == name).unwrap_or(false) {
                out.last_mut().unwrap().columns.push(column);
            } else {
                out.push(crate::domain::IndexInfo { name, columns: vec![column], unique, primary });
            }
        }
        Ok(out)
    }

    pub async fn table_comment(conn: &DbConnection, database: &str, table: &str) -> AppResult<String> {
        let row = sqlx::query("select obj_description(format('%I.%I', $1, $2)::regclass, 'pg_class')")
            .bind(database)
            .bind(table)
            .fetch_optional(conn.as_postgres())
            .await?;
        Ok(row
            .and_then(|r| r.try_get::<Option<String>, _>(0).unwrap_or(None))
            .unwrap_or_default())
    }

    pub async fn apply_changes(
        conn: &DbConnection,
        database: &str,
        table: &str,
        changes: &[crate::domain::Change],
    ) -> AppResult<usize> {
        // PG 对参数类型很严格：把每个参数显式转成对应列的类型，行为才和 MySQL 一致。
        let columns = Self::list_columns(conn, database, table).await?;
        let types: std::collections::HashMap<String, String> = columns
            .into_iter()
            .map(|c| (c.name, super::pg_cast_type(&c.raw_type)))
            .collect();
        let table_ref = format!("{}.{}", quote(database), quote(table));
        let eq = "IS NOT DISTINCT FROM";

        let mut tx = conn.as_postgres().begin().await?;
        let mut applied = 0usize;
        for (i, change) in changes.iter().enumerate() {
            let (sql, params): (String, Vec<Option<String>>) = match change {
                crate::domain::Change::Insert { values } => {
                    if values.is_empty() {
                        continue;
                    }
                    let cols: Vec<String> = values.iter().map(|v| quote(&v.column)).collect();
                    let phs: Vec<String> = values
                        .iter()
                        .enumerate()
                        .map(|(k, v)| format!("${}::{}", k + 1, types.get(&v.column).map(String::as_str).unwrap_or("text")))
                        .collect();
                    (
                        format!("INSERT INTO {} ({}) VALUES ({})", table_ref, cols.join(", "), phs.join(", ")),
                        values.iter().map(|v| v.value.clone()).collect(),
                    )
                }
                crate::domain::Change::Update { pk, values, original } => {
                    if pk.is_empty() || values.is_empty() {
                        continue;
                    }
                    let mut params: Vec<Option<String>> = Vec::new();
                    let mut n = 0usize;
                    let set: Vec<String> = values
                        .iter()
                        .map(|v| {
                            n += 1;
                            params.push(v.value.clone());
                            format!("{} = ${}::{}", quote(&v.column), n, types.get(&v.column).map(String::as_str).unwrap_or("text"))
                        })
                        .collect();
                    let mut wh = Vec::new();
                    for v in pk.iter().chain(original.iter()) {
                        n += 1;
                        params.push(v.value.clone());
                        wh.push(format!(
                            "{} {} ${}::{}",
                            quote(&v.column),
                            eq,
                            n,
                            types.get(&v.column).map(String::as_str).unwrap_or("text")
                        ));
                    }
                    (
                        format!("UPDATE {} SET {} WHERE {}", table_ref, set.join(", "), wh.join(" AND ")),
                        params,
                    )
                }
                crate::domain::Change::Delete { pk } => {
                    if pk.is_empty() {
                        continue;
                    }
                    let params: Vec<Option<String>> = pk.iter().map(|v| v.value.clone()).collect();
                    let wh: Vec<String> = pk
                        .iter()
                        .enumerate()
                        .map(|(k, v)| format!(
                            "{} {} ${}::{}",
                            quote(&v.column),
                            eq,
                            k + 1,
                            types.get(&v.column).map(String::as_str).unwrap_or("text")
                        ))
                        .collect();
                    (format!("DELETE FROM {} WHERE {}", table_ref, wh.join(" AND ")), params)
                }
            };
            let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
            for p in &params {
                match p {
                    Some(v) => q = q.bind(v.clone()),
                    None => q = q.bind(None::<String>),
                }
            }
            let result = q
                .execute(&mut *tx)
                .await
                .map_err(|e| super::change_failed(i, &format!("执行失败：{e}")))?;
            if result.rows_affected() != 1 {
                return Err(super::change_failed(
                    i,
                    &format!(
                        "匹配到 {} 行（应为 1 行）：这行可能已被其他人修改或删除，本次改动已全部回滚",
                        result.rows_affected()
                    ),
                ));
            }
            applied += 1;
        }
        tx.commit().await?;
        Ok(applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Change, ColumnValue, DbFlavor};

    fn cfg() -> ConnectionConfig {
        ConnectionConfig {
            id: "pg".into(),
            name: "pg".into(),
            host: std::env::var("PGHOST").unwrap_or_default(),
            port: std::env::var("PGPORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5432),
            username: std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into()),
            database: std::env::var("PGDATABASE").ok(),
            flavor: DbFlavor::Postgres,
            file_path: None,
            ssl_mode: None,
            ssl_ca: None,
            ssl_cert: None,
            ssl_key: None,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_auth_method: None,
            ssh_private_key_path: None,
            oracle_conn_type: None,
            oracle_role: None,
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 PostgreSQL，用 PGPASSWORD 环境变量
    async fn connects_lists_and_queries() {
        let password = std::env::var("PGPASSWORD").expect("PGPASSWORD required");
        let conn = PostgresDriver::connect(&cfg(), &password, None).await.unwrap();

        let dbs = PostgresDriver::list_databases(&conn).await.unwrap();
        assert!(dbs.iter().any(|d| d == "public"));

        let schema = "public";
        PostgresDriver::query(&conn, Some(schema), "DROP TABLE IF EXISTS t_pg", 10).await.unwrap();
        PostgresDriver::query(
            &conn,
            Some(schema),
            "CREATE TABLE t_pg (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, \
             name varchar(32) NOT NULL, price numeric(10,2), flag boolean, data jsonb, \
             created_at timestamp, created_tz timestamptz, tags text[])",
            10,
        )
        .await
        .unwrap();
        PostgresDriver::query(&conn, Some(schema), "COMMENT ON COLUMN t_pg.name IS '名字'", 10).await.unwrap();
        PostgresDriver::query(&conn, Some(schema), "COMMENT ON TABLE t_pg IS '表注释'", 10).await.unwrap();

        let cols = PostgresDriver::list_columns(&conn, schema, "t_pg").await.unwrap();
        let by_name = |n: &str| cols.iter().find(|c| c.name == n).unwrap();
        assert!(by_name("id").primary_key && by_name("id").auto_increment);
        assert_eq!(by_name("name").comment, "名字");
        assert_eq!(by_name("price").raw_type, "numeric(10,2)");
        assert_eq!(by_name("created_tz").data_type, "timestamptz");
        assert_eq!(PostgresDriver::table_comment(&conn, schema, "t_pg").await.unwrap(), "表注释");

        let changes = vec![Change::Insert {
            values: vec![
                ColumnValue { column: "name".into(), value: Some("abc".into()) },
                ColumnValue { column: "price".into(), value: Some("12.34".into()) },
                ColumnValue { column: "flag".into(), value: Some("true".into()) },
                ColumnValue { column: "data".into(), value: Some("{\"k\":1}".into()) },
            ],
        }];
        assert_eq!(PostgresDriver::apply_changes(&conn, schema, "t_pg", &changes).await.unwrap(), 1);

        let rs = PostgresDriver::query(&conn, Some(schema), "SELECT * FROM t_pg", 10).await.unwrap();
        assert_eq!(rs.rows.len(), 1);
        assert_eq!(rs.rows[0][1], Value::Str("abc".to_string()));
        assert_eq!(rs.rows[0][2], Value::Decimal("12.34".to_string()));
        assert_eq!(rs.rows[0][3], Value::Bool(true));
        assert!(matches!(rs.rows[0][4], Value::Json(_)));

        PostgresDriver::query(&conn, Some(schema), "DROP TABLE t_pg", 10).await.unwrap();
    }
}
