use futures::StreamExt;
use sqlx::{Column as _, Row as _, TypeInfo as _, ValueRef as _};
use sqlx::mysql::MySqlSslMode;

use super::{ColumnInfo, DbConnection, RelationalDriver, TableInfo};
use crate::domain::{Column, ConnectionConfig, GraphEdge, ResultSet, SchemaGraph, TableSchema, Value};
use crate::error::AppResult;

pub struct MysqlDriver;

fn connect_options(
    config: &ConnectionConfig,
    password: &str,
    host: &str,
    port: u16,
) -> sqlx::mysql::MySqlConnectOptions {
    let mut opts = sqlx::mysql::MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(&config.username)
        // sqlx 默认会把会话时区强制设成 +00:00，导致应用写入的 NOW()/CURRENT_TIMESTAMP
        // 与 mysql 客户端等其他工具相差一个时区。改回服务端时区，行为和其他工具一致。
        // 我们只用 NaiveDate/NaiveTime/NaiveDateTime，不受时区偏移影响。
        .timezone(None);
    // 密码为空时不能调 .password("")：sqlx 对空串照样算 20 字节裸响应，而 MySQL 协议
    // 要求空密码发零长度响应。否则密码为空的账号（本地 root、TiDB 默认账号）会被判成
    // 「用密码登录」直接拒绝。不调就是 None，sqlx 会发空响应。
    if !password.is_empty() {
        opts = opts.password(password);
    }
    if let Some(db) = &config.database {
        opts = opts.database(db);
    }
    if let Some(mode) = config.ssl_mode.as_deref() {
        opts = opts.ssl_mode(match mode {
            "disabled" => MySqlSslMode::Disabled,
            "required" => MySqlSslMode::Required,
            "verify_ca" => MySqlSslMode::VerifyCa,
            "verify_identity" => MySqlSslMode::VerifyIdentity,
            _ => MySqlSslMode::Preferred,
        });
    }
    if let Some(ca) = config.ssl_ca.as_deref() {
        opts = opts.ssl_ca(ca);
    }
    if let Some(cert) = config.ssl_cert.as_deref() {
        opts = opts.ssl_client_cert(cert);
    }
    if let Some(key) = config.ssl_key.as_deref() {
        opts = opts.ssl_client_key(key);
    }
    opts
}

/// 绕过 sqlx 的类型兼容性检查，直接按 UTF-8 读取原始报文。
///
/// `Row::try_get::<String>` 会先做 `str::compatible()` 校验，而那个白名单里没有
/// DECIMAL / JSON，于是报「mismatched types」；但它们本身就是文本，能读出来。
fn raw_text(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
    let raw = row.try_get_raw(i).ok()?;
    if raw.is_null() {
        return None;
    }
    let s: &str = <&str as sqlx::Decode<'_, sqlx::MySql>>::decode(raw).ok()?;
    Some(s.to_string())
}

fn value_from_row(row: &sqlx::mysql::MySqlRow, i: usize) -> sqlx::Result<Value> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let ty = raw.type_info().name().to_ascii_lowercase();
    let value = match ty.as_str() {
        "boolean" => row.try_get::<bool, _>(i).map(Value::Bool).ok(),
        "tinyint" => row.try_get::<i8, _>(i).map(|v| Value::Int(v as i64)).ok(),
        "tinyint unsigned" => row.try_get::<u8, _>(i).map(|v| Value::Int(v as i64)).ok(),
        "smallint" => row.try_get::<i16, _>(i).map(|v| Value::Int(v as i64)).ok(),
        "smallint unsigned" => row.try_get::<u16, _>(i).map(|v| Value::Int(v as i64)).ok(),
        "int" | "mediumint" => row.try_get::<i32, _>(i).map(|v| Value::Int(v as i64)).ok(),
        "int unsigned" | "mediumint unsigned" => {
            row.try_get::<u32, _>(i).map(|v| Value::Int(v as i64)).ok()
        }
        "bigint" => row.try_get::<i64, _>(i).map(Value::Int).ok(),
        "bigint unsigned" => row.try_get::<u64, _>(i).map(Value::UInt).ok(),
        "year" => row
            .try_get::<i32, _>(i)
            .or_else(|_| row.try_get::<u16, _>(i).map(|v| v as i32))
            .map(|v| Value::Int(v as i64))
            .ok(),
        "float" => row.try_get::<f32, _>(i).map(|v| Value::Float(v as f64)).ok(),
        "double" => row.try_get::<f64, _>(i).map(Value::Float).ok(),
        "decimal" => raw_text(row, i).map(Value::Decimal),
        "date" => row
            .try_get::<chrono::NaiveDate, _>(i)
            .map(|v| Value::Date(v.to_string()))
            .ok(),
        "time" => row
            .try_get::<chrono::NaiveTime, _>(i)
            .map(|v| Value::Time(v.to_string()))
            .ok(),
        "datetime" | "timestamp" => row
            .try_get::<chrono::NaiveDateTime, _>(i)
            .map(|v| Value::DateTime(v.to_string()))
            .ok(),
        "json" => raw_text(row, i).map(Value::Json),
        "char" | "varchar" | "text" | "tinytext" | "mediumtext" | "longtext" | "enum" | "set" => {
            row.try_get::<String, _>(i).map(Value::Str).ok()
        }
        "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "bit"
        | "geometry" => row.try_get::<Vec<u8>, _>(i).map(Value::Bytes).ok(),
        _ => None,
    };
    if let Some(v) = value {
        return Ok(v);
    }
    // 未知类型的兜底：按常见解码顺序尝试，尽量不因单列类型导致整条查询失败。
    if let Ok(v) = row.try_get::<i64, _>(i) {
        return Ok(Value::Int(v));
    }
    if let Ok(v) = row.try_get::<u64, _>(i) {
        return Ok(Value::UInt(v));
    }
    if let Ok(v) = row.try_get::<f64, _>(i) {
        return Ok(Value::Float(v));
    }
    if let Ok(v) = row.try_get::<String, _>(i) {
        return Ok(Value::Str(v));
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(i) {
        return Ok(Value::Bytes(v));
    }
    // 最后再试一次原始文本，避免将来出现新类型时又一次静默变成 NULL
    if let Some(s) = raw_text(row, i) {
        return Ok(Value::Str(s));
    }
    Ok(Value::Null)
}

fn columns_of(row: &sqlx::mysql::MySqlRow) -> Vec<Column> {
    row.columns()
        .iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: crate::driver::declared_type_name(c.type_info().name()),
        })
        .collect()
}

impl RelationalDriver for MysqlDriver {
    async fn connect(config: &ConnectionConfig, password: &str) -> AppResult<DbConnection> {
        MysqlDriver::connect(config, password, None).await
    }

    async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>> {
        let rows = sqlx::query("SHOW DATABASES")
            .fetch_all(conn.as_mysql())
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(row.try_get::<String, _>(0)?);
        }
        Ok(out)
    }

    async fn list_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(database)
        .fetch_all(conn.as_mysql())
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(TableInfo { name: row.try_get::<String, _>(0)? });
        }
        Ok(out)
    }

    async fn list_columns(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        let rows = sqlx::query(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_TYPE, \
                    COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(conn.as_mysql())
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(ColumnInfo {
                name: row.try_get::<String, _>(0)?,
                data_type: row.try_get::<String, _>(1)?,
                nullable: row.try_get::<String, _>(2)?.eq_ignore_ascii_case("YES"),
                primary_key: row.try_get::<String, _>(3)?.eq_ignore_ascii_case("PRI"),
                raw_type: row.try_get::<String, _>(4)?,
                default_value: row.try_get::<Option<String>, _>(5)?,
                auto_increment: row
                    .try_get::<String, _>(6)?
                    .to_ascii_lowercase()
                    .contains("auto_increment"),
                comment: row.try_get::<String, _>(7)?,
            });
        }
        Ok(out)
    }

    async fn query(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let pool = conn.as_mysql();
        let mut c = pool.acquire().await?;
        if let Some(db) = database {
            if !db.is_empty() {
                let use_sql = format!("USE `{}`", db.replace('`', "``"));
                sqlx::raw_sql(sqlx::AssertSqlSafe(use_sql.as_str()))
                    .execute(&mut *c)
                    .await?;
            }
        }
        let started = std::time::Instant::now();
        let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).fetch(&mut *c);

        let mut rows: Vec<sqlx::mysql::MySqlRow> = Vec::new();
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

    async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64> {
        let row = sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .fetch_one(conn.as_mysql())
            .await?;
        let n: i64 = row.try_get(0)?;
        Ok(n)
    }
}

impl MysqlDriver {
    pub async fn connect(
        config: &ConnectionConfig,
        password: &str,
        ssh_password: Option<String>,
    ) -> AppResult<DbConnection> {
        // SSH 隧道：先建隧道，再把 sqlx 指到本地转发端口
        let (host, port) = if config.ssh_enabled {
            let tunnel = crate::ssh_tunnel::start_tunnel(
                config,
                &config.host,
                config.port,
                ssh_password,
            )
            .await?;
            let port = tunnel.local_port;
            crate::ssh_tunnel::register(&config.id, tunnel);
            ("127.0.0.1".to_string(), port)
        } else {
            (config.host.clone(), config.port)
        };
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(4)
            .connect_with(connect_options(config, password, &host, port))
            .await?;
        Ok(DbConnection::Mysql(pool))
    }

    async fn apply_database(c: &mut sqlx::MySqlConnection, database: Option<&str>) -> AppResult<()> {
        if let Some(db) = database {
            if !db.is_empty() {
                let use_sql = format!("USE `{}`", db.replace('`', "``"));
                sqlx::raw_sql(sqlx::AssertSqlSafe(use_sql.as_str()))
                    .execute(&mut *c)
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn query_bound(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        params: Vec<String>,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let mut c = conn.as_mysql().acquire().await?;
        Self::apply_database(&mut c, database).await?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for p in params {
            q = q.bind(p);
        }
        let started = std::time::Instant::now();
        let mut stream = q.fetch(&mut *c);
        let mut rows: Vec<sqlx::mysql::MySqlRow> = Vec::new();
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
        let mut c = conn.as_mysql().acquire().await?;
        Self::apply_database(&mut c, database).await?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for p in params {
            q = q.bind(p);
        }
        let row = q.fetch_one(&mut *c).await?;
        Ok(row.try_get::<i64, _>(0)?)
    }

    pub async fn schema_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableSchema>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(database)
        .fetch_all(conn.as_mysql())
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

    /// ER 图用：两条查询拿全整库结构（字段 + 外键），只画真实外键，不做推断
    pub async fn schema_graph(conn: &DbConnection, database: &str) -> AppResult<SchemaGraph> {
        let cols = sqlx::query(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(database)
        .fetch_all(conn.as_mysql())
        .await?;
        let columns = cols
            .into_iter()
            .map(|r| {
                (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                    r.try_get::<String, _>(2).unwrap_or_default(),
                    r.try_get::<String, _>(3).map(|s| s.eq_ignore_ascii_case("YES")).unwrap_or(true),
                    r.try_get::<String, _>(4).map(|s| s == "PRI").unwrap_or(false),
                    r.try_get::<String, _>(5).unwrap_or_default(),
                )
            })
            .collect();
        // 表注释在 information_schema.TABLES 里，单独一条查询
        let table_comments: std::collections::HashMap<String, String> = sqlx::query(
            "SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
        )
        .bind(database)
        .fetch_all(conn.as_mysql())
        .await?
        .into_iter()
        .filter_map(|r| Some((r.try_get::<String, _>(0).ok()?, r.try_get::<String, _>(1).ok()?)))
        .collect();
        let fks = sqlx::query(
            "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
        )
        .bind(database)
        .fetch_all(conn.as_mysql())
        .await?;
        let mut edges: Vec<GraphEdge> = Vec::new();
        for row in fks {
            edges.push(GraphEdge {
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
        let sql = format!(
            "SHOW CREATE TABLE `{}`.`{}`",
            database.replace('`', "``"),
            table.replace('`', "``")
        );
        let row = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.as_str()))
            .fetch_one(conn.as_mysql())
            .await?;
        Ok(row.try_get::<String, _>(1)?)
    }

    pub async fn foreign_keys(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<crate::domain::ForeignKeyRef>> {
        let rows = sqlx::query(
            "SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
        )
        .bind(database)
        .bind(table)
        .fetch_all(conn.as_mysql())
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(crate::domain::ForeignKeyRef {
                column: row.try_get::<String, _>(0)?,
                ref_table: row.try_get::<String, _>(1)?,
                ref_column: row.try_get::<String, _>(2)?,
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
            "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(database)
        .bind(table)
        .fetch_all(conn.as_mysql())
        .await?;
        let mut out: Vec<crate::domain::IndexInfo> = Vec::new();
        for row in rows {
            let name: String = row.try_get(0)?;
            let column: String = row.try_get(1)?;
            let non_unique: i64 = row.try_get(2)?;
            if out.last().map(|ix| ix.name == name).unwrap_or(false) {
                out.last_mut().unwrap().columns.push(column);
            } else {
                out.push(crate::domain::IndexInfo {
                    primary: name == "PRIMARY",
                    unique: non_unique == 0,
                    name,
                    columns: vec![column],
                });
            }
        }
        Ok(out)
    }

    pub async fn table_comment(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<String> {
        let row = sqlx::query(
            "SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(conn.as_mysql())
        .await?;
        Ok(row.map(|r| r.try_get::<String, _>(0).unwrap_or_default()).unwrap_or_default())
    }

    pub async fn apply_changes(
        conn: &DbConnection,
        database: &str,
        table: &str,
        changes: &[crate::domain::Change],
    ) -> AppResult<usize> {
        let mut tx = conn.as_mysql().begin().await?;
        let mut applied = 0usize;
        for (i, change) in changes.iter().enumerate() {
            let Some(stmt) =
                super::build_change_statement(super::Dialect::Mysql, database, table, change)
            else {
                continue;
            };
            let mut q = sqlx::query(sqlx::AssertSqlSafe(stmt.sql.as_str()));
            for p in &stmt.params {
                q = q.bind(p);
            }
            // 任何一条失败都直接返回，事务对象被丢弃即回滚
            let result = q
                .execute(&mut *tx)
                .await
                .map_err(|e| super::change_failed(i, &format!("执行失败：{e}")))?;
            if result.rows_affected() != 1 {
                // 值改成大小写等价时 MySQL 报 0 行；用原始值再查一次，能查到就是「没变」
                if matches!(change, crate::domain::Change::Update { .. })
                    && result.rows_affected() == 0
                    && let Some(check) =
                        super::build_existence_check(super::Dialect::Mysql, database, table, change)
                {
                    let mut cq = sqlx::query(sqlx::AssertSqlSafe(check.sql.as_str()));
                    for p in &check.params {
                        cq = cq.bind(p);
                    }
                    if cq.fetch_optional(&mut *tx).await?.is_some() {
                        continue; // 其实值没变，当作成功，不计入
                    }
                }
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
    use crate::domain::{Change, ColumnValue, ConnectionConfig, DbFlavor, Value};

    fn test_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "it".into(),
            name: "integration".into(),
            host: std::env::var("DB_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: std::env::var("DB_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3306),
            username: std::env::var("DB_USER").unwrap_or_else(|_| "root".into()),
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
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 MySQL，用 DB_PASSWORD 环境变量
    async fn connects_lists_and_queries() {
        let cfg = test_config();
        let pw = std::env::var("DB_PASSWORD").expect("DB_PASSWORD required");
        let conn = MysqlDriver::connect(&cfg, &pw, None).await.unwrap();

        let dbs = MysqlDriver::list_databases(&conn).await.unwrap();
        assert!(dbs.iter().any(|d| d == "information_schema"));

        let tables = MysqlDriver::list_tables(&conn, "information_schema").await.unwrap();
        assert!(tables.iter().any(|t| t.name == "TABLES"));

        let cols = MysqlDriver::list_columns(&conn, "information_schema", "TABLES").await.unwrap();
        assert!(cols.iter().any(|c| c.name == "TABLE_NAME"));

        let rs = MysqlDriver::query(
            &conn,
            None,
            "SELECT 1 AS one, 'x' AS s, NULL AS n, TRUE AS b, 1.5 AS f, NOW() AS t, 123.45 AS d",
            1000,
        )
        .await
        .unwrap();
        assert_eq!(rs.columns.len(), 7);
        assert_eq!(rs.rows.len(), 1);
        assert!(!rs.truncated);
        // 字面量 TRUE 在 MySQL 里就是 TINYINT(1)，按整数解出来即可（关键是不能再报解码错误）
        assert_eq!(rs.rows[0][3], Value::Int(1));

        let total = MysqlDriver::count(&conn, "SELECT COUNT(*) FROM information_schema.TABLES").await.unwrap();
        assert!(total > 0);

        // 会话时区必须是服务端的，不能被 sqlx 默认的 +00:00 覆盖，
        // 否则应用里的 NOW()/CURRENT_TIMESTAMP 会比其他客户端差一个时区。
        let tz = MysqlDriver::query(&conn, None, "SELECT @@session.time_zone", 10).await.unwrap();
        assert_eq!(
            tz.rows[0][0],
            Value::Str("SYSTEM".to_string()),
            "会话时区应跟随服务端，实际 {:?}",
            tz.rows[0][0]
        );

        // 验证会话库上下文：USE information_schema 后，未加库名的表也能查
        let scoped = MysqlDriver::query(&conn, Some("information_schema"), "SELECT COUNT(*) FROM TABLES", 10).await.unwrap();
        assert_eq!(scoped.rows.len(), 1);

        // 验证参数化绑定（表预览的筛选走这条路径）
        let bound = MysqlDriver::query_bound(&conn, None, "SELECT ? AS v", vec!["hi".to_string()], 10).await.unwrap();
        assert_eq!(bound.rows.len(), 1);
        assert_eq!(bound.rows[0][0], crate::domain::Value::Str("hi".to_string()));

        // 验证 schema 内省（表 + 字段，供 SQL 自动补全）
        let schema = MysqlDriver::schema_tables(&conn, "information_schema").await.unwrap();
        let tables_schema = schema.iter().find(|s| s.name == "TABLES").expect("TABLES in schema");
        assert!(tables_schema.columns.iter().any(|c| c == "TABLE_NAME"));

        // 验证取建表语句
        let ddl = MysqlDriver::table_ddl(&conn, "information_schema", "TABLES").await.unwrap();
        assert!(ddl.to_uppercase().contains("CREATE"));

        // apply_changes 冒烟：临时库表上的插入/更新，随后清理
        MysqlDriver::query(&conn, Some(""), "CREATE DATABASE IF NOT EXISTS dbdesktop_test", 10).await.unwrap();
        MysqlDriver::query(&conn, Some("dbdesktop_test"), "DROP TABLE IF EXISTS t_edit", 10).await.unwrap();
        MysqlDriver::query(
            &conn,
            Some("dbdesktop_test"),
            "CREATE TABLE t_edit (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), flag BOOLEAN, note VARCHAR(20) DEFAULT 'n/a')",
            10,
        )
        .await
        .unwrap();

        // 列元数据：自增与默认值
        let meta = MysqlDriver::list_columns(&conn, "dbdesktop_test", "t_edit").await.unwrap();
        let col = |n: &str| meta.iter().find(|c| c.name == n).unwrap().clone();
        assert!(col("id").auto_increment);
        assert!(!col("name").auto_increment);
        assert_eq!(col("note").default_value.as_deref(), Some("n/a"));
        assert_eq!(col("name").default_value, None);

        // 回归：真实表里的 BOOLEAN 列 + 比较表达式 + 参数化绑定，三条路径都不能再出现
        // 「Rust type String ... not compatible with SQL type BOOLEAN」这类解码错误。
        MysqlDriver::query(
            &conn,
            Some("dbdesktop_test"),
            "INSERT INTO t_edit (name, flag) VALUES ('a', TRUE)",
            10,
        )
        .await
        .unwrap();
        let bool_rs = MysqlDriver::query(
            &conn,
            Some("dbdesktop_test"),
            "SELECT id, name, flag, note, name = 'a' AS computed FROM t_edit",
            10,
        )
        .await
        .unwrap();
        assert_eq!(bool_rs.rows.len(), 1);
        // 表里的 BOOLEAN 列 → 协议类型名带 bool 标记，解成 Bool
        assert_eq!(bool_rs.rows[0][2], Value::Bool(true));
        assert_eq!(bool_rs.rows[0][3], Value::Str("n/a".to_string()));
        // 表达式 `name = 'a'` 被 MySQL 报成 TINYINT，按整数解
        assert_eq!(bool_rs.rows[0][4], Value::Int(1));
        let bound_bool = MysqlDriver::query_bound(
            &conn,
            Some("dbdesktop_test"),
            "SELECT flag FROM t_edit WHERE name = ?",
            vec!["a".to_string()],
            10,
        )
        .await
        .unwrap();
        assert_eq!(bound_bool.rows[0][0], Value::Bool(true));

        MysqlDriver::query(&conn, Some("dbdesktop_test"), "DELETE FROM t_edit", 10).await.unwrap();
        let changes = vec![
            Change::Insert {
                values: vec![
                    ColumnValue { column: "id".into(), value: Some("1".into()) },
                    ColumnValue { column: "name".into(), value: Some("a".into()) },
                ],
            },
            Change::Update {
                pk: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
                values: vec![ColumnValue { column: "name".into(), value: Some("b".into()) }],
                original: vec![ColumnValue { column: "name".into(), value: Some("a".into()) }],
            },
        ];
        MysqlDriver::apply_changes(&conn, "dbdesktop_test", "t_edit", &changes).await.unwrap();
        let r = MysqlDriver::query(&conn, Some("dbdesktop_test"), "SELECT name FROM t_edit WHERE id = 1", 10).await.unwrap();
        assert_eq!(r.rows[0][0], Value::Str("b".to_string()));

        // 原始值对不上（别人改过）→ 报错定位到第几条并回滚
        let stale = vec![Change::Update {
            pk: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
            values: vec![ColumnValue { column: "name".into(), value: Some("c".into()) }],
            original: vec![ColumnValue { column: "name".into(), value: Some("早就不是这个值了".into()) }],
        }];
        let err = MysqlDriver::apply_changes(&conn, "dbdesktop_test", "t_edit", &stale)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("第 1 条改动"), "实际错误：{err}");
        let r = MysqlDriver::query(&conn, Some("dbdesktop_test"), "SELECT name FROM t_edit WHERE id = 1", 10).await.unwrap();
        assert_eq!(r.rows[0][0], Value::Str("b".to_string()));

        MysqlDriver::query(&conn, Some(""), "DROP DATABASE dbdesktop_test", 10).await.unwrap();
    }

    /// 非空列不允许被解成 NULL：只要有一种类型解码失败，就会出现「数据明明有值却显示 NULL」。
    #[tokio::test]
    #[ignore] // 需要真实 MySQL，用 DB_PASSWORD 环境变量
    async fn decodes_all_common_types() {
        let cfg = test_config();
        let pw = std::env::var("DB_PASSWORD").expect("DB_PASSWORD required");
        let conn = MysqlDriver::connect(&cfg, &pw, None).await.unwrap();

        MysqlDriver::query(&conn, Some(""), "CREATE DATABASE IF NOT EXISTS dbdesktop_types", 10)
            .await
            .unwrap();
        MysqlDriver::query(&conn, Some("dbdesktop_types"), "DROP TABLE IF EXISTS t_all", 10)
            .await
            .unwrap();
        MysqlDriver::query(
            &conn,
            Some("dbdesktop_types"),
            "CREATE TABLE t_all ( \
               c_tinyint TINYINT, c_smallint SMALLINT, c_mediumint MEDIUMINT, c_int INT, \
               c_bigint BIGINT, c_utinyint TINYINT UNSIGNED, c_uint INT UNSIGNED, \
               c_float FLOAT, c_double DOUBLE, c_decimal DECIMAL(12,3), \
               c_date DATE, c_time TIME, c_datetime DATETIME, c_year YEAR, \
               c_char CHAR(4), c_varchar VARCHAR(20), c_text TEXT, c_json JSON, \
               c_blob BLOB, c_bit BIT(3), c_enum ENUM('a','b'), c_set SET('x','y'), \
               c_bool BOOLEAN )",
            10,
        )
        .await
        .unwrap();
        MysqlDriver::query(
            &conn,
            Some("dbdesktop_types"),
            "INSERT INTO t_all VALUES ( \
               1, 2, 3, 4, 5, 6, 7, \
               1.5, 2.5, 3.125, \
               '2026-01-02', '03:04:05', '2026-01-02 03:04:05', 2026, \
               'abcd', 'v', 'txt', '{\"k\": 1}', X'0102', b'101', 'a', 'x,y', TRUE )",
            10,
        )
        .await
        .unwrap();

        let rs = MysqlDriver::query(&conn, Some("dbdesktop_types"), "SELECT * FROM t_all", 10)
            .await
            .unwrap();
        let row = &rs.rows[0];
        let nulls: Vec<String> = rs
            .columns
            .iter()
            .zip(row.iter())
            .filter(|(_, v)| **v == Value::Null)
            .map(|(c, _)| format!("{} ({})", c.name, c.type_name))
            .collect();
        assert!(nulls.is_empty(), "这些非空列被解成了 NULL: {nulls:?}");
        assert_eq!(row[9], Value::Decimal("3.125".to_string()));
        assert!(matches!(row[17], Value::Json(_)), "json 列应解成 Json，实际 {:?}", row[17]);
        assert_eq!(row[20], Value::Str("a".to_string()));
        // 二进制协议（表预览走的是带参数绑定这条路）同样不能丢值
        let bound = MysqlDriver::query_bound(
            &conn,
            Some("dbdesktop_types"),
            "SELECT * FROM t_all WHERE 1 = ?",
            vec!["1".to_string()],
            10,
        )
        .await
        .unwrap();
        let nulls_bound: Vec<String> = bound
            .columns
            .iter()
            .zip(bound.rows[0].iter())
            .filter(|(_, v)| **v == Value::Null)
            .map(|(c, _)| format!("{} ({})", c.name, c.type_name))
            .collect();
        assert!(nulls_bound.is_empty(), "参数化查询下这些列被解成了 NULL: {nulls_bound:?}");
        assert_eq!(row[21], Value::Str("x,y".to_string()));

        MysqlDriver::query(&conn, Some(""), "DROP DATABASE dbdesktop_types", 10).await.unwrap();
    }
}
