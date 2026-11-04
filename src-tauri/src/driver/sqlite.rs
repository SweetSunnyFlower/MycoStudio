use futures::StreamExt;
use sqlx::{Column as _, Row as _, TypeInfo as _, ValueRef as _};

use super::{ColumnInfo, DbConnection, TableInfo};
use crate::domain::{Column, ConnectionConfig, GraphEdge, ResultSet, SchemaGraph, TableSchema, Value};
use crate::error::{AppError, AppResult};

pub struct SqliteDriver;

fn value_from_row(row: &sqlx::sqlite::SqliteRow, i: usize) -> sqlx::Result<Value> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let ty = raw.type_info().name().to_ascii_lowercase();
    let value = match ty.as_str() {
        "integer" => row.try_get::<i64, _>(i).map(Value::Int).ok(),
        "real" => row.try_get::<f64, _>(i).map(Value::Float).ok(),
        "text" => row.try_get::<String, _>(i).map(Value::Str).ok(),
        "blob" => row.try_get::<Vec<u8>, _>(i).map(Value::Bytes).ok(),
        _ => None,
    };
    if let Some(v) = value {
        return Ok(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(i) {
        return Ok(Value::Int(v));
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
    Ok(Value::Null)
}

fn columns_of(row: &sqlx::sqlite::SqliteRow) -> Vec<Column> {
    row.columns()
        .iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: crate::driver::declared_type_name(c.type_info().name()),
        })
        .collect()
}

impl SqliteDriver {
    pub async fn connect(config: &ConnectionConfig, _password: &str) -> AppResult<DbConnection> {
        let path = config
            .file_path
            .as_deref()
            .ok_or_else(|| AppError::Message("SQLite 需要文件路径".to_string()))?;
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;
        Ok(DbConnection::Sqlite(pool))
    }

    pub async fn list_databases(_conn: &DbConnection) -> AppResult<Vec<String>> {
        Ok(vec!["main".to_string()])
    }

    pub async fn list_tables(conn: &DbConnection, _database: &str) -> AppResult<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(conn.as_sqlite())
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(TableInfo { name: row.try_get::<String, _>(0)? });
        }
        Ok(out)
    }

    pub async fn list_columns(
        conn: &DbConnection,
        _database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        let rows =
            sqlx::query("SELECT name, type, \"notnull\", pk, dflt_value FROM pragma_table_info(?)")
                .bind(table)
                .fetch_all(conn.as_sqlite())
                .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let notnull: i64 = row.try_get(2)?;
            let pk: i64 = row.try_get(3)?;
            out.push(ColumnInfo {
                name: row.try_get::<String, _>(0)?,
                data_type: row.try_get::<String, _>(1)?,
                nullable: notnull == 0,
                primary_key: pk > 0,
                raw_type: row.try_get::<String, _>(1)?,
                default_value: row.try_get::<Option<String>, _>(4)?,
                auto_increment: false,
                comment: String::new(),
            });
        }
        // SQLite 没有 AUTO_INCREMENT：单列 `INTEGER PRIMARY KEY` 是 rowid 别名，由数据库自动生成。
        let pk_indexes: Vec<usize> = out
            .iter()
            .enumerate()
            .filter(|(_, c)| c.primary_key)
            .map(|(i, _)| i)
            .collect();
        if let [only] = pk_indexes[..] {
            if out[only].data_type.trim().eq_ignore_ascii_case("integer") {
                out[only].auto_increment = true;
            }
        }
        Ok(out)
    }

    pub async fn query(
        conn: &DbConnection,
        _database: Option<&str>,
        sql: &str,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let pool = conn.as_sqlite();
        let started = std::time::Instant::now();
        let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).fetch(pool);

        let mut rows: Vec<sqlx::sqlite::SqliteRow> = Vec::new();
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
        let row = sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .fetch_one(conn.as_sqlite())
            .await?;
        Ok(row.try_get::<i64, _>(0)?)
    }

    pub async fn query_bound(
        conn: &DbConnection,
        _database: Option<&str>,
        sql: &str,
        params: Vec<String>,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let pool = conn.as_sqlite();
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for p in params {
            q = q.bind(p);
        }
        let started = std::time::Instant::now();
        let mut stream = q.fetch(pool);
        let mut rows: Vec<sqlx::sqlite::SqliteRow> = Vec::new();
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
        _database: Option<&str>,
        sql: &str,
        params: Vec<String>,
    ) -> AppResult<i64> {
        let pool = conn.as_sqlite();
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for p in params {
            q = q.bind(p);
        }
        let row = q.fetch_one(pool).await?;
        Ok(row.try_get::<i64, _>(0)?)
    }

    pub async fn schema_tables(conn: &DbConnection, _database: &str) -> AppResult<Vec<TableSchema>> {
        let rows = sqlx::query(
            "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid",
        )
        .fetch_all(conn.as_sqlite())
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

    /// ER 图用：sqlite_master + pragma 表函数，一次拿全字段与外键（只画真实外键）
    pub async fn schema_graph(conn: &DbConnection, _database: &str) -> AppResult<SchemaGraph> {
        let cols = sqlx::query(
            "SELECT m.name, p.name, p.type, p.\"notnull\", p.pk \
             FROM sqlite_master m JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, p.cid",
        )
        .fetch_all(conn.as_sqlite())
        .await?;
        let mut pk_of: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let columns = cols
            .into_iter()
            .map(|r| {
                let table: String = r.try_get(0).unwrap_or_default();
                let name: String = r.try_get(1).unwrap_or_default();
                let is_pk = r.try_get::<i64, _>(4).map(|n| n > 0).unwrap_or(false);
                if is_pk {
                    pk_of.entry(table.clone()).or_insert_with(|| name.clone());
                }
                (
                    table,
                    name,
                    r.try_get::<String, _>(2).unwrap_or_default(),
                    r.try_get::<i64, _>(3).map(|n| n == 0).unwrap_or(true),
                    is_pk,
                    // SQLite 没有列注释
                    String::new(),
                )
            })
            .collect();
        // pragma_foreign_key_list 的 "to" 在「引用目标主键但没写出列名」时是 NULL
        let fks = sqlx::query(
            "SELECT m.name, fk.\"from\", fk.\"table\", fk.\"to\" \
             FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk \
             WHERE m.type = 'table'",
        )
        .fetch_all(conn.as_sqlite())
        .await?;
        let mut edges: Vec<GraphEdge> = Vec::new();
        for row in fks {
            let from_table: String = row.try_get(0)?;
            let from_column: String = row.try_get(1)?;
            let to_table: String = row.try_get(2)?;
            let to_column: Option<String> = row.try_get(3)?;
            // 没写目标列：按 SQLite 规则就是目标表的主键，取该表第一个主键列
            let to_column = to_column
                .or_else(|| pk_of.get(&to_table).cloned())
                .unwrap_or_default();
            edges.push(GraphEdge { from_table, from_column, to_table, to_column, name: String::new() });
        }
        Ok(super::assemble_graph(columns, edges, std::collections::HashMap::new()))
    }

    pub async fn table_ddl(conn: &DbConnection, _database: &str, table: &str) -> AppResult<String> {
        let row = sqlx::query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_one(conn.as_sqlite())
            .await?;
        let ddl: Option<String> = row.try_get(0)?;
        Ok(ddl.unwrap_or_default())
    }

    pub async fn foreign_keys(
        conn: &DbConnection,
        table: &str,
    ) -> AppResult<Vec<crate::domain::ForeignKeyRef>> {
        let rows = sqlx::query("SELECT `from`, `table`, `to` FROM pragma_foreign_key_list(?)")
            .bind(table)
            .fetch_all(conn.as_sqlite())
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
        table: &str,
    ) -> AppResult<Vec<crate::domain::IndexInfo>> {
        let list = sqlx::query("SELECT name, \"unique\", origin FROM pragma_index_list(?)")
            .bind(table)
            .fetch_all(conn.as_sqlite())
            .await?;
        let mut out = Vec::with_capacity(list.len());
        for row in list {
            let name: String = row.try_get(0)?;
            let unique: i64 = row.try_get(1)?;
            let origin: String = row.try_get(2)?;
            let cols = sqlx::query("SELECT name FROM pragma_index_info(?)")
                .bind(&name)
                .fetch_all(conn.as_sqlite())
                .await?;
            let columns = cols
                .into_iter()
                .map(|c| c.try_get::<String, _>(0))
                .collect::<Result<Vec<_>, _>>()?;
            out.push(crate::domain::IndexInfo {
                name,
                columns,
                unique: unique != 0,
                primary: origin == "pk",
            });
        }
        Ok(out)
    }

    /// SQLite 没有表注释概念
    pub async fn table_comment(_conn: &DbConnection, _table: &str) -> AppResult<String> {
        Ok(String::new())
    }

    pub async fn apply_changes(
        conn: &DbConnection,
        database: &str,
        table: &str,
        changes: &[crate::domain::Change],
    ) -> AppResult<usize> {
        let mut tx = conn.as_sqlite().begin().await?;
        let mut applied = 0usize;
        for (i, change) in changes.iter().enumerate() {
            let Some(stmt) =
                super::build_change_statement(super::Dialect::Sqlite, database, table, change)
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
                if matches!(change, crate::domain::Change::Update { .. })
                    && result.rows_affected() == 0
                    && let Some(check) =
                        super::build_existence_check(super::Dialect::Sqlite, database, table, change)
                {
                    let mut cq = sqlx::query(sqlx::AssertSqlSafe(check.sql.as_str()));
                    for p in &check.params {
                        cq = cq.bind(p);
                    }
                    if cq.fetch_optional(&mut *tx).await?.is_some() {
                        continue;
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
    use crate::domain::{ConnectionConfig, DbFlavor};

    #[tokio::test]
    async fn sqlite_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dbdesktop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let cfg = ConnectionConfig {
            id: "s".into(),
            name: "sqlite".into(),
            host: String::new(),
            port: 0,
            username: String::new(),
            database: None,
            flavor: DbFlavor::Sqlite,
            file_path: Some(path.to_string_lossy().to_string()),
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
        let conn = SqliteDriver::connect(&cfg, "").await.unwrap();
        sqlx::raw_sql("CREATE TABLE t (id INTEGER, name TEXT)")
            .execute(conn.as_sqlite())
            .await
            .unwrap();

        let dbs = SqliteDriver::list_databases(&conn).await.unwrap();
        assert_eq!(dbs, vec!["main".to_string()]);

        let tables = SqliteDriver::list_tables(&conn, "main").await.unwrap();
        assert!(tables.iter().any(|t| t.name == "t"));

        let cols = SqliteDriver::list_columns(&conn, "main", "t").await.unwrap();
        assert_eq!(cols.len(), 2);

        sqlx::raw_sql("CREATE TABLE tpk (id INTEGER PRIMARY KEY, v TEXT)")
            .execute(conn.as_sqlite())
            .await
            .unwrap();
        let pkcols = SqliteDriver::list_columns(&conn, "main", "tpk").await.unwrap();
        assert!(pkcols.iter().find(|c| c.name == "id").unwrap().primary_key);
        assert!(!pkcols.iter().find(|c| c.name == "v").unwrap().primary_key);
        // 单列 INTEGER PRIMARY KEY 是 rowid 别名，视为自增
        assert!(pkcols.iter().find(|c| c.name == "id").unwrap().auto_increment);
        assert!(!pkcols.iter().find(|c| c.name == "v").unwrap().auto_increment);

        // 默认值：有 DEFAULT 的列取到表达式，没有的为 None；普通 INTEGER 主键也算自增
        sqlx::raw_sql(
            "CREATE TABLE tdef (id INTEGER PRIMARY KEY, n INTEGER DEFAULT 5, s TEXT DEFAULT 'x', u INTEGER)",
        )
        .execute(conn.as_sqlite())
        .await
        .unwrap();
        let defcols = SqliteDriver::list_columns(&conn, "main", "tdef").await.unwrap();
        let by_name = |n: &str| defcols.iter().find(|c| c.name == n).unwrap().clone();
        assert_eq!(by_name("n").default_value.as_deref(), Some("5"));
        assert_eq!(by_name("s").default_value.as_deref(), Some("'x'"));
        assert_eq!(by_name("u").default_value, None);
        assert!(by_name("id").auto_increment);
        assert!(!by_name("n").auto_increment);

        // 索引：建唯一索引后应能列出，含列名与 unique 标记
        sqlx::raw_sql("CREATE UNIQUE INDEX idx_tpk_v ON tpk (v)")
            .execute(conn.as_sqlite())
            .await
            .unwrap();
        let idxs = SqliteDriver::indexes(&conn, "tpk").await.unwrap();
        let idx = idxs.iter().find(|i| i.name == "idx_tpk_v").expect("idx_tpk_v listed");
        assert_eq!(idx.columns, vec!["v".to_string()]);
        assert!(idx.unique && !idx.primary);

        let schema = SqliteDriver::schema_tables(&conn, "main").await.unwrap();
        let t_schema = schema.iter().find(|s| s.name == "t").expect("table t in schema");
        assert_eq!(t_schema.columns, vec!["id".to_string(), "name".to_string()]);

        let ddl = SqliteDriver::table_ddl(&conn, "main", "t").await.unwrap();
        assert!(ddl.to_uppercase().contains("CREATE TABLE"));

        // 事务批量写：插入、更新、删除
        let changes = vec![
            crate::domain::Change::Insert {
                values: vec![
                    crate::domain::ColumnValue { column: "id".into(), value: Some("1".into()) },
                    crate::domain::ColumnValue { column: "name".into(), value: Some("a".into()) },
                ],
            },
            crate::domain::Change::Update {
                pk: vec![crate::domain::ColumnValue { column: "id".into(), value: Some("1".into()) }],
                values: vec![crate::domain::ColumnValue { column: "name".into(), value: Some("b".into()) }],
                original: vec![crate::domain::ColumnValue { column: "name".into(), value: Some("a".into()) }],
            },
            crate::domain::Change::Insert {
                values: vec![
                    crate::domain::ColumnValue { column: "id".into(), value: Some("2".into()) },
                    crate::domain::ColumnValue { column: "name".into(), value: Some("c".into()) },
                ],
            },
            crate::domain::Change::Delete {
                pk: vec![crate::domain::ColumnValue { column: "id".into(), value: Some("2".into()) }],
            },
        ];
        assert_eq!(SqliteDriver::apply_changes(&conn, "main", "t", &changes).await.unwrap(), 4);
        let rs = crate::driver::query(&conn, None, "SELECT id, name FROM t ORDER BY id", 100).await.unwrap();
        assert_eq!(rs.rows.len(), 1);
        assert_eq!(rs.rows[0][1], crate::domain::Value::Str("b".to_string()));

        // 事务回滚：第二条更新不存在的列导致失败，第一条插入也不应生效
        let bad = vec![
            crate::domain::Change::Insert {
                values: vec![
                    crate::domain::ColumnValue { column: "id".into(), value: Some("3".into()) },
                    crate::domain::ColumnValue { column: "name".into(), value: Some("x".into()) },
                ],
            },
            crate::domain::Change::Update {
                pk: vec![crate::domain::ColumnValue { column: "id".into(), value: Some("1".into()) }],
                values: vec![crate::domain::ColumnValue { column: "nope".into(), value: Some("y".into()) }],
                original: vec![],
            },
        ];
        let err = SqliteDriver::apply_changes(&conn, "main", "t", &bad).await.unwrap_err().to_string();
        // 错误信息要带上「第几条改动」，前端靠它定位到具体行
        assert!(err.starts_with("第 2 条改动"), "实际错误：{err}");
        let cnt = crate::driver::query(&conn, None, "SELECT COUNT(*) FROM t", 10).await.unwrap();
        assert_eq!(cnt.rows[0][0], crate::domain::Value::Int(1));

        // 影响 0 行（行已被删/被改成别的值）也要报错并回滚
        let stale = vec![crate::domain::Change::Update {
            pk: vec![crate::domain::ColumnValue { column: "id".into(), value: Some("1".into()) }],
            values: vec![crate::domain::ColumnValue { column: "name".into(), value: Some("z".into()) }],
            original: vec![crate::domain::ColumnValue { column: "name".into(), value: Some("别的值".into()) }],
        }];
        let err = SqliteDriver::apply_changes(&conn, "main", "t", &stale).await.unwrap_err().to_string();
        assert!(err.starts_with("第 1 条改动"), "实际错误：{err}");
        let rs = crate::driver::query(&conn, None, "SELECT name FROM t WHERE id = 1", 10).await.unwrap();
        assert_eq!(rs.rows[0][0], crate::domain::Value::Str("b".to_string()));

        let rs = crate::driver::query(&conn, None, "SELECT 1 AS one, 'x' AS s, NULL AS n", 100)
            .await
            .unwrap();
        assert_eq!(rs.columns.len(), 3);
        assert_eq!(rs.rows.len(), 1);
    }

    /// SQLite 对表达式列报不出声明类型，sqlx 会给回字面量 "NULL"。
    /// 直接透传到界面会被读成「这一列的值是 NULL」，所以没有声明类型时应该是空串。
    #[tokio::test]
    async fn expression_columns_have_no_declared_type() {
        let dir = std::env::temp_dir().join(format!("dbdesktop-type-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let cfg = ConnectionConfig {
            id: "s".into(),
            name: "sqlite".into(),
            host: String::new(),
            port: 0,
            username: String::new(),
            database: None,
            flavor: DbFlavor::Sqlite,
            file_path: Some(path.to_string_lossy().to_string()),
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
        let conn = SqliteDriver::connect(&cfg, "").await.unwrap();
        sqlx::raw_sql("CREATE TABLE t (id INTEGER, name TEXT)")
            .execute(conn.as_sqlite())
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO t (id, name) VALUES (1, 'a')")
            .execute(conn.as_sqlite())
            .await
            .unwrap();

        // 真实列的声明类型照常带出来，别一起抹掉
        let real = crate::driver::query(&conn, None, "SELECT id, name FROM t", 10).await.unwrap();
        assert_eq!(real.columns[0].type_name, "INTEGER");
        assert_eq!(real.columns[1].type_name, "TEXT");

        // 表达式列：没有声明类型，不应是字面量 "NULL"
        let expr = crate::driver::query(&conn, None, "SELECT COUNT(*) AS n, 1 + 1 AS two", 10)
            .await
            .unwrap();
        assert_eq!(expr.columns[0].type_name, "", "COUNT(*) 的 type_name");
        assert_eq!(expr.columns[1].type_name, "", "1 + 1 的 type_name");
    }
}
