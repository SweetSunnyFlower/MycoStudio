//! Oracle 驱动：走 Oracle 官方的 `oracledb`（rust-oracledb）thin 驱动。
//!
//! 它是**纯 Rust** 实现，不需要 Instant Client / OCI 动态库，所以打包分发没有任何
//! 客户端依赖；代价是只支持 Oracle 19c / 21c / 26ai（官方支持矩阵），而且 API 是
//! **阻塞式**的——这里所有调用都丢进 `spawn_blocking`。
//!
//! 另一个约束：一条 Oracle 连接就是一个会话，会话里不能并发跑语句，
//! 所以 `OracleConn` 用 `Mutex` 把同一条连接上的访问串行化。

use std::sync::{Arc, Mutex};
use std::time::Instant;

use oracledb::{DbType, OracleNumber, OracleTimestamp, Row as OraRow, ToDbValue};

use super::{build_change_statement, build_existence_check, change_failed, ColumnInfo, DbConnection, Dialect, TableInfo};
use crate::domain::{Column, ConnectionConfig, ResultSet, TableSchema, Value};
use crate::error::{AppError, AppResult};

/// 执行计划用的 statement_id（每次覆盖同一条，避免残留行堆积）
const PLAN_STMT_ID: &str = "MYCO_STUDIO";

pub struct OracleConn {
    conn: Mutex<oracledb::Connection>,
}

impl OracleConn {
    /// 同步执行一段操作（由 `with_conn` 放到阻塞线程里调用）
    fn locked<T>(&self, f: impl FnOnce(&oracledb::Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| AppError::Message("Oracle 连接状态异常，请重新连接".into()))?;
        f(&guard)
    }
}

/// 把阻塞的 Oracle 调用挪到阻塞线程池里跑，返回结果
async fn with_conn<T, F>(conn: &DbConnection, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&oracledb::Connection) -> AppResult<T> + Send + 'static,
{
    let oracle = conn.as_oracle().clone();
    tokio::task::spawn_blocking(move || oracle.locked(f))
        .await
        .map_err(|e| AppError::Message(format!("Oracle 调用失败：{e}")))?
}

/// 把驱动错误尽量翻译成人能看懂的话
fn ora_err(e: oracledb::Error) -> AppError {
    AppError::Message(format!("Oracle 错误：{e}"))
}

fn is_query_sql(sql: &str) -> bool {
    // 跳过开头的注释，不然「-- 注释\nSELECT ...」会被当成非查询语句
    let mut t = sql.trim_start();
    loop {
        if let Some(rest) = t.strip_prefix("--") {
            t = rest.split_once('\n').map(|(_, r)| r).unwrap_or("").trim_start();
        } else if let Some(rest) = t.strip_prefix("/*") {
            t = rest.split_once("*/").map(|(_, r)| r).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    let upper = t.chars().take(24).collect::<String>().to_ascii_uppercase();
    upper.starts_with("SELECT") || upper.starts_with("WITH")
}

/// Oracle 的字符串绑定：`None` 表示 NULL
fn string_binds(params: &[String]) -> Vec<Option<&str>> {
    params.iter().map(|p| Some(p.as_str())).collect()
}

/// 变动的绑定值可能为 NULL（None），保持 NULL 语义
fn optional_binds(params: &[Option<String>]) -> Vec<Option<&str>> {
    params.iter().map(|p| p.as_deref()).collect()
}

/// 一行 + 列元信息 → 项目的 `Value`
fn extract(row: &OraRow, idx: usize, ty: &'static DbType) -> Value {
    if ty.is_binary_type() {
        if let Ok(v) = row.get::<Option<Vec<u8>>>(idx) {
            return v.map(Value::Bytes).unwrap_or(Value::Null);
        }
    }
    if ty.is_date_type() {
        if let Ok(v) = row.get::<Option<OracleTimestamp>>(idx) {
            return v.map(|t| Value::DateTime(format_timestamp(&t, ty))).unwrap_or(Value::Null);
        }
    }
    if ty.is_string_type() {
        if let Ok(v) = row.get::<Option<String>>(idx) {
            return v.map(Value::Str).unwrap_or(Value::Null);
        }
    }
    if ty.num() == oracledb::DB_TYPE_BOOLEAN.num() {
        if let Ok(v) = row.get::<Option<bool>>(idx) {
            return v.map(Value::Bool).unwrap_or(Value::Null);
        }
    }
    if ty.num() == oracledb::DB_TYPE_BINARY_FLOAT.num()
        || ty.num() == oracledb::DB_TYPE_BINARY_DOUBLE.num()
    {
        if let Ok(v) = row.get::<Option<f64>>(idx) {
            return v.map(Value::Float).unwrap_or(Value::Null);
        }
    }
    // NUMBER：整数用 Int，其余保留原始十进制文本（不丢精度）
    if let Ok(v) = row.get::<Option<OracleNumber>>(idx) {
        return match v {
            None => Value::Null,
            Some(n) => {
                let text = n.to_string();
                match text.parse::<i64>() {
                    Ok(i) => Value::Int(i),
                    Err(_) => Value::Decimal(text),
                }
            }
        };
    }
    // 兜底：JSON / VECTOR / INTERVAL / XMLTYPE 之类，能当字符串取就当字符串
    if let Ok(v) = row.get::<Option<String>>(idx) {
        return v.map(Value::Str).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.get::<Option<Vec<u8>>>(idx) {
        return v.map(Value::Bytes).unwrap_or(Value::Null);
    }
    Value::Null
}

/// DATE / TIMESTAMP 一律按 `YYYY-MM-DD HH24:MI:SS[.FF][ +TZH:TZM]` 输出。
///
/// 不用驱动自带的 Display：它会输出 `2026-10-13T07:07:08.000000000Z` 这种
/// RFC3339 形态，界面上难看，而且回写时和会话 NLS 格式对不上。
fn format_timestamp(ts: &OracleTimestamp, ty: &'static DbType) -> String {
    let mut out = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        ts.year(),
        ts.month(),
        ts.day(),
        ts.hour(),
        ts.minute(),
        ts.second()
    );
    let is_date = ty.num() == oracledb::DB_TYPE_DATE.num();
    // DATE 没有小数秒
    let nanos = ts.nanoseconds();
    if !is_date && nanos > 0 {
        let frac = format!("{nanos:09}");
        out.push('.');
        out.push_str(frac.trim_end_matches('0'));
    }
    if ty.num() == oracledb::DB_TYPE_TIMESTAMP_TZ.num() {
        let hour = ts.tz_hour_offset();
        let minute = ts.tz_minute_offset();
        let sign = if hour < 0 || minute < 0 { '-' } else { '+' };
        out.push_str(&format!(" {sign}{:02}:{:02}", hour.abs(), minute.abs()));
    }
    out
}

/// 执行一条查询并转成 ResultSet（同步，供阻塞线程内部复用）
fn fetch(
    conn: &oracledb::Connection,
    sql: &str,
    binds: &[&dyn ToDbValue],
    max_rows: usize,
) -> AppResult<ResultSet> {
    let started = Instant::now();
    // 非查询语句（DDL / DML / PL/SQL 块）走 execute，界面只关心耗时
    if !is_query_sql(sql) {
        conn.execute(sql, binds).map_err(ora_err)?;
        return Ok(ResultSet {
            columns: Vec::new(),
            rows: Vec::new(),
            truncated: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }
    let cursor = conn.query(sql, binds).map_err(ora_err)?;
    // 列信息先取出来：这样即使 0 行也能正确显示表头
    let meta: Vec<(String, String, &'static DbType)> = cursor
        .columns()
        .iter()
        .map(|m| {
            let ty = m.db_type();
            (m.name().to_string(), display_type(ty, m.data_type()), ty)
        })
        .collect();
    let columns = meta
        .iter()
        .map(|(name, type_name, _)| Column { name: name.clone(), type_name: type_name.clone() })
        .collect();

    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    for row in cursor {
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        let row = row.map_err(ora_err)?;
        let mut values = Vec::with_capacity(meta.len());
        for (i, (_, _, ty)) in meta.iter().enumerate() {
            values.push(extract(&row, i, ty));
        }
        rows.push(values);
    }
    Ok(ResultSet {
        columns,
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 当前 schema 没选的话，未限定名的对象会落到登录用户自己的 schema
fn set_current_schema(conn: &oracledb::Connection, schema: &str) -> AppResult<()> {
    if schema.trim().is_empty() {
        return Ok(());
    }
    let sql = format!("ALTER SESSION SET CURRENT_SCHEMA = {}", Dialect::Oracle.quote(schema));
    // 尽力而为：切不过去（比如传进来的是服务名、或者没有权限）就保持会话默认 schema，
    // 不要让「整条 SQL 直接失败」——那会让用户连自己 schema 里的表都查不到
    if let Err(e) = conn.execute(&sql, &[]) {
        eprintln!("设置 CURRENT_SCHEMA 为 {schema} 失败，沿用会话默认 schema：{e}");
    }
    Ok(())
}

fn connect_string(config: &ConnectionConfig, host: &str, port: u16) -> AppResult<String> {
    let target = config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Message("请填写 Oracle 服务名（或 SID）".into()))?;
    let by_sid = config.oracle_conn_type.as_deref() == Some("sid");
    Ok(if by_sid {
        // Easy Connect 语法只认服务名，SID 必须走完整的连接描述符
        format!(
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST={host})(PORT={port}))(CONNECT_DATA=(SID={target})))"
        )
    } else {
        format!("{host}:{port}/{target}")
    })
}

/// 固定会话的 NLS 格式：我们所有 SQL 里的字符串字面量 / 绑定值都按这个格式
/// 和 DATE、TIMESTAMP、NUMBER 互转，避免受服务器 NLS 设置影响。
fn init_session(conn: &oracledb::Connection) {
    let stmts = [
        "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
        "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'",
        "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'",
        "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'",
    ];
    for sql in stmts {
        // 有的库会限制 ALTER SESSION，失败也不影响基本使用
        let _ = conn.execute(sql, &[]);
    }
}

pub struct OracleDriver;

impl OracleDriver {
    pub async fn connect(
        config: &ConnectionConfig,
        password: &str,
        ssh_password: Option<String>,
    ) -> AppResult<DbConnection> {
        let (host, port) = if config.ssh_enabled {
            let tunnel =
                crate::ssh_tunnel::start_tunnel(config, &config.host, config.port, ssh_password).await?;
            let port = tunnel.local_port;
            crate::ssh_tunnel::register(&config.id, tunnel);
            ("127.0.0.1".to_string(), port)
        } else {
            (config.host.clone(), config.port)
        };
        let connect_string = connect_string(config, &host, port)?;
        let user = config.username.clone();
        let password = password.to_string();
        let role = config.oracle_role.clone();
        let conn = tokio::task::spawn_blocking(move || -> AppResult<oracledb::Connection> {
            let mut cfg = oracledb::Config::default()
                .set_credentials(&user, &password)
                .set_connect_string(&connect_string)
                .map_err(ora_err)?;
            if let Some(role) = role.as_deref() {
                let mode = match role.to_ascii_uppercase().as_str() {
                    "SYSDBA" => Some(oracledb::AUTH_MODE_SYSDBA),
                    "SYSOPER" => Some(oracledb::AUTH_MODE_SYSOPER),
                    _ => None,
                };
                if let Some(mode) = mode {
                    cfg = cfg.set_auth_mode(mode);
                }
            }
            let conn = oracledb::connect(cfg).map_err(ora_err)?;
            init_session(&conn);
            Ok(conn)
        })
        .await
        .map_err(|e| AppError::Message(format!("Oracle 连接失败：{e}")))??;
        Ok(DbConnection::Oracle(Arc::new(OracleConn { conn: Mutex::new(conn) })))
    }

    /// 工作台左侧的「数据库」= Oracle 的 schema（用户）
    pub async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>> {
        with_conn(conn, |c| {
            let sql = "SELECT username FROM all_users \
                       WHERE oracle_maintained = 'N' \
                          OR username = SYS_CONTEXT('USERENV', 'SESSION_USER') \
                       ORDER BY username";
            let cursor = c.query(sql, &[]).map_err(ora_err)?;
            let mut out = Vec::new();
            for row in cursor {
                let row = row.map_err(ora_err)?;
                if let Ok(Some(name)) = row.get::<Option<String>>(0) {
                    out.push(name);
                }
            }
            // 登录用户自己的 schema 排最前：界面默认选它，未限定表名也就落在它上面
            if let Ok(row) = c.query_row("SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL", &[]) {
                if let Ok(Some(current)) = row.get::<Option<String>>(0) {
                    if let Some(pos) = out.iter().position(|s| s == &current) {
                        let me = out.remove(pos);
                        out.insert(0, me);
                    }
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn list_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableInfo>> {
        let schema = database.to_string();
        with_conn(conn, move |c| {
            let sql = "SELECT table_name FROM all_tables WHERE owner = :1 \
                       UNION ALL \
                       SELECT view_name FROM all_views WHERE owner = :1 \
                       ORDER BY 1";
            // 位置绑定按「占位符出现次数」取值，同一个值用两次就要传两次
            let binds: Vec<&dyn ToDbValue> = vec![&schema, &schema];
            let cursor = c.query(sql, &binds).map_err(ora_err)?;
            let mut out = Vec::new();
            for row in cursor {
                let row = row.map_err(ora_err)?;
                if let Ok(Some(name)) = row.get::<Option<String>>(0) {
                    out.push(TableInfo { name });
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn list_columns(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        let schema = database.to_string();
        let table = table.to_string();
        with_conn(conn, move |c| {
            let sql = "SELECT c.column_name, c.data_type, c.nullable, c.data_default, \
                              c.data_length, c.char_length, c.data_precision, c.data_scale, \
                              NVL(cc.comments, ''), \
                              CASE WHEN EXISTS ( \
                                  SELECT 1 FROM all_constraints k \
                                  JOIN all_cons_columns kc ON kc.owner = k.owner \
                                       AND kc.constraint_name = k.constraint_name \
                                  WHERE k.owner = c.owner AND k.table_name = c.table_name \
                                    AND k.constraint_type = 'P' AND kc.column_name = c.column_name \
                              ) THEN 1 ELSE 0 END, \
                              CASE WHEN EXISTS ( \
                                  SELECT 1 FROM all_tab_identity_cols i \
                                  WHERE i.owner = c.owner AND i.table_name = c.table_name \
                                    AND i.column_name = c.column_name \
                              ) THEN 1 ELSE 0 END \
                       FROM all_tab_columns c \
                       LEFT JOIN all_col_comments cc ON cc.owner = c.owner \
                            AND cc.table_name = c.table_name AND cc.column_name = c.column_name \
                       WHERE c.owner = :1 AND c.table_name = :2 \
                       ORDER BY c.column_id";
            let binds: Vec<&dyn ToDbValue> = vec![&schema, &table];
            let cursor = c.query(sql, &binds).map_err(ora_err)?;
            let mut out = Vec::new();
            for row in cursor {
                let row = row.map_err(ora_err)?;
                let data_type: String = row.get::<Option<String>>(1).ok().flatten().unwrap_or_default();
                let raw_type = oracle_raw_type(
                    &data_type,
                    row.get::<Option<i64>>(4).ok().flatten().unwrap_or(0),
                    row.get::<Option<i64>>(5).ok().flatten().unwrap_or(0),
                    row.get::<Option<i64>>(6).ok().flatten().unwrap_or(0),
                    row.get::<Option<i64>>(7).ok().flatten().unwrap_or(0),
                );
                let default_value = row
                    .get::<Option<String>>(3)
                    .ok()
                    .flatten()
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty());
                out.push(ColumnInfo {
                    name: row.get::<Option<String>>(0).ok().flatten().unwrap_or_default(),
                    data_type: normalize_type(&data_type),
                    nullable: row.get::<Option<String>>(2).ok().flatten().unwrap_or_default() == "Y",
                    primary_key: row.get::<Option<i64>>(9).ok().flatten().unwrap_or(0) == 1,
                    raw_type,
                    default_value,
                    auto_increment: row.get::<Option<i64>>(10).ok().flatten().unwrap_or(0) == 1,
                    comment: row.get::<Option<String>>(8).ok().flatten().unwrap_or_default(),
                });
            }
            Ok(out)
        })
        .await
    }

    pub async fn query(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let schema = database.map(str::to_string);
        let sql = sql.to_string();
        with_conn(conn, move |c| {
            if let Some(schema) = schema.as_deref() {
                set_current_schema(c, schema)?;
            }
            fetch(c, &sql, &[], max_rows)
        })
        .await
    }

    pub async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64> {
        let sql = sql.to_string();
        with_conn(conn, move |c| {
            let row = c.query_row(&sql, &[]).map_err(ora_err)?;
            Ok(row
                .get::<Option<OracleNumber>>(0)
                .ok()
                .flatten()
                .and_then(|n| n.to_string().parse::<i64>().ok())
                .unwrap_or(0))
        })
        .await
    }

    pub async fn query_bound(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        params: Vec<String>,
        max_rows: usize,
    ) -> AppResult<ResultSet> {
        let schema = database.map(str::to_string);
        let sql = sql.to_string();
        with_conn(conn, move |c| {
            if let Some(schema) = schema.as_deref() {
                set_current_schema(c, schema)?;
            }
            // 扫描出来的筛选值一律按字符串绑定：会话的 NLS 格式已经在连接时固定，
            // 和 NUMBER / DATE 的隐式转换是确定的
            let owned = string_binds(&params);
            let binds: Vec<&dyn ToDbValue> = owned.iter().map(|v| v as &dyn ToDbValue).collect();
            fetch(c, &sql, &binds, max_rows)
        })
        .await
    }

    pub async fn count_bound(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
        params: Vec<String>,
    ) -> AppResult<i64> {
        let schema = database.map(str::to_string);
        let sql = sql.to_string();
        with_conn(conn, move |c| {
            if let Some(schema) = schema.as_deref() {
                set_current_schema(c, schema)?;
            }
            let owned = string_binds(&params);
            let binds: Vec<&dyn ToDbValue> = owned.iter().map(|v| v as &dyn ToDbValue).collect();
            let row = c.query_row(&sql, &binds).map_err(ora_err)?;
            Ok(row
                .get::<Option<OracleNumber>>(0)
                .ok()
                .flatten()
                .and_then(|n| n.to_string().parse::<i64>().ok())
                .unwrap_or(0))
        })
        .await
    }

    /// 库里所有表 + 字段名（给 AI 当上下文用；一次查完，别 N+1）
    pub async fn schema_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableSchema>> {
        let schema = database.to_string();
        with_conn(conn, move |c| {
            let sql = "SELECT t.table_name, t.column_name FROM ( \
                           SELECT table_name, column_name, column_id FROM all_tab_columns WHERE owner = :1 \
                           UNION ALL \
                           SELECT v.view_name, vc.column_name, vc.column_id FROM all_views v \
                           JOIN all_tab_cols vc ON vc.owner = v.owner AND vc.table_name = v.view_name \
                           WHERE v.owner = :1 \
                       ) t ORDER BY t.table_name, t.column_id";
            let binds: Vec<&dyn ToDbValue> = vec![&schema, &schema];
            let cursor = c.query(sql, &binds).map_err(ora_err)?;
            let mut out: Vec<TableSchema> = Vec::new();
            for row in cursor {
                let row = row.map_err(ora_err)?;
                let table: String = row.get::<Option<String>>(0).ok().flatten().unwrap_or_default();
                let column: String = row.get::<Option<String>>(1).ok().flatten().unwrap_or_default();
                if out.last().map(|t| t.name == table).unwrap_or(false) {
                    out.last_mut().unwrap().columns.push(column);
                } else {
                    out.push(TableSchema { name: table, columns: vec![column] });
                }
            }
            Ok(out)
        })
        .await
    }

    /// ER 图用：整库字段（含主键）+ 外键，两条查询搞定（只画真实外键）
    pub async fn schema_graph(conn: &DbConnection, database: &str) -> AppResult<crate::domain::SchemaGraph> {
        let schema = database.to_string();
        with_conn(conn, move |c| {
            let col_sql = "SELECT c.table_name, c.column_name, c.data_type, c.data_length, \
                                  c.char_length, c.data_precision, c.data_scale, c.nullable, \
                                  CASE WHEN EXISTS ( \
                                      SELECT 1 FROM all_constraints k \
                                      JOIN all_cons_columns kc ON kc.owner = k.owner \
                                           AND kc.constraint_name = k.constraint_name \
                                      WHERE k.owner = c.owner AND k.table_name = c.table_name \
                                        AND k.constraint_type = 'P' AND kc.column_name = c.column_name \
                                  ) THEN 1 ELSE 0 END, \
                                  NVL(cc.comments, '') \
                           FROM all_tab_columns c \
                           LEFT JOIN all_col_comments cc ON cc.owner = c.owner \
                                AND cc.table_name = c.table_name AND cc.column_name = c.column_name \
                           WHERE c.owner = :1 \
                           ORDER BY c.table_name, c.column_id";
            let binds: Vec<&dyn ToDbValue> = vec![&schema];
            let mut columns: Vec<(String, String, String, bool, bool, String)> = Vec::new();
            for row in c.query(col_sql, &binds).map_err(ora_err)? {
                let row = row.map_err(ora_err)?;
                let data_type: String = row.get::<Option<String>>(2).ok().flatten().unwrap_or_default();
                let raw_type = oracle_raw_type(
                    &data_type,
                    row.get::<Option<i64>>(3).ok().flatten().unwrap_or(0),
                    row.get::<Option<i64>>(4).ok().flatten().unwrap_or(0),
                    row.get::<Option<i64>>(5).ok().flatten().unwrap_or(0),
                    row.get::<Option<i64>>(6).ok().flatten().unwrap_or(0),
                );
                columns.push((
                    row.get::<Option<String>>(0).ok().flatten().unwrap_or_default(),
                    row.get::<Option<String>>(1).ok().flatten().unwrap_or_default(),
                    raw_type,
                    row.get::<Option<String>>(7).ok().flatten().unwrap_or_default() == "Y",
                    row.get::<Option<i64>>(8).ok().flatten().unwrap_or(0) == 1,
                    row.get::<Option<String>>(9).ok().flatten().unwrap_or_default(),
                ));
            }
            // 表注释：all_tab_comments
            let mut table_comments: std::collections::HashMap<String, String> = std::collections::HashMap::new();
            let tc_sql = "SELECT table_name, NVL(comments, '') FROM all_tab_comments WHERE owner = :1";
            for row in c.query(tc_sql, &binds).map_err(ora_err)? {
                let row = row.map_err(ora_err)?;
                let name: String = row.get::<Option<String>>(0).ok().flatten().unwrap_or_default();
                let comment: String = row.get::<Option<String>>(1).ok().flatten().unwrap_or_default();
                if !name.is_empty() && !comment.is_empty() {
                    table_comments.insert(name, comment);
                }
            }
            let fk_sql = "SELECT c.table_name, c.column_name, rc.table_name, rcc.column_name \
                          FROM all_constraints k \
                          JOIN all_cons_columns c ON c.owner = k.owner \
                               AND c.constraint_name = k.constraint_name \
                          JOIN all_constraints rc ON rc.owner = k.r_owner \
                               AND rc.constraint_name = k.r_constraint_name \
                          JOIN all_cons_columns rcc ON rcc.owner = rc.owner \
                               AND rcc.constraint_name = rc.constraint_name \
                               AND rcc.position = c.position \
                          WHERE k.owner = :1 AND k.constraint_type = 'R' \
                          ORDER BY c.table_name, c.position";
            let mut edges: Vec<crate::domain::GraphEdge> = Vec::new();
            for row in c.query(fk_sql, &binds).map_err(ora_err)? {
                let row = row.map_err(ora_err)?;
                edges.push(crate::domain::GraphEdge {
                    from_table: row.get::<Option<String>>(0).ok().flatten().unwrap_or_default(),
                    from_column: row.get::<Option<String>>(1).ok().flatten().unwrap_or_default(),
                    to_table: row.get::<Option<String>>(2).ok().flatten().unwrap_or_default(),
                    to_column: row.get::<Option<String>>(3).ok().flatten().unwrap_or_default(),
                    name: String::new(),
                });
            }
            Ok(super::assemble_graph(columns, edges, table_comments))
        })
        .await
    }

    /// 建表语句：直接问数据库要（DBMS_METADATA）
    pub async fn table_ddl(conn: &DbConnection, database: &str, table: &str) -> AppResult<String> {
        let schema = database.to_string();
        let table = table.to_string();
        with_conn(conn, move |c| {
            // 先问清楚这是表还是视图：对视图名用 'TABLE' 去取，DBMS_METADATA
            // 会返回视图那层「伪表」的 CREATE TABLE，看着像对的、其实是错的。
            let kind = c
                .query_row(
                    "SELECT object_type FROM all_objects WHERE owner = :1 AND object_name = :2",
                    &[&schema as &dyn ToDbValue, &table],
                )
                .ok()
                .and_then(|row| row.get::<Option<String>>(0).ok().flatten())
                .unwrap_or_else(|| "TABLE".to_string());
            let metadata_kind = match kind.as_str() {
                "VIEW" => "VIEW",
                "MATERIALIZED VIEW" => "MATERIALIZED_VIEW",
                _ => "TABLE",
            };
            for object_type in [metadata_kind, "TABLE", "VIEW"] {
                let sql = "SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM DUAL";
                let binds: Vec<&dyn ToDbValue> = vec![&object_type, &table, &schema];
                if let Ok(row) = c.query_row(sql, &binds) {
                    if let Ok(Some(ddl)) = row.get::<Option<String>>(0) {
                        let ddl = ddl.trim().to_string();
                        if !ddl.is_empty() {
                            return Ok(ensure_semicolon(&ddl));
                        }
                    }
                }
            }
            // 拿不到就退回手写一份（至少字段和主键是全的）
            Ok(manual_ddl(c, &schema, &table)?)
        })
        .await
    }

    pub async fn foreign_keys(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<crate::domain::ForeignKeyRef>> {
        let schema = database.to_string();
        let table = table.to_string();
        with_conn(conn, move |c| {
            let sql = "SELECT cc.column_name, rc.table_name, rcc.column_name \
                       FROM all_constraints c \
                       JOIN all_cons_columns cc ON cc.owner = c.owner \
                            AND cc.constraint_name = c.constraint_name \
                       JOIN all_constraints rc ON rc.owner = c.r_owner \
                            AND rc.constraint_name = c.r_constraint_name \
                       JOIN all_cons_columns rcc ON rcc.owner = rc.owner \
                            AND rcc.constraint_name = rc.constraint_name \
                            AND rcc.position = cc.position \
                       WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'R' \
                       ORDER BY cc.position";
            let binds: Vec<&dyn ToDbValue> = vec![&schema, &table];
            let cursor = c.query(sql, &binds).map_err(ora_err)?;
            let mut out = Vec::new();
            for row in cursor {
                let row = row.map_err(ora_err)?;
                out.push(crate::domain::ForeignKeyRef {
                    column: row.get::<Option<String>>(0).ok().flatten().unwrap_or_default(),
                    ref_table: row.get::<Option<String>>(1).ok().flatten().unwrap_or_default(),
                    ref_column: row.get::<Option<String>>(2).ok().flatten().unwrap_or_default(),
                });
            }
            Ok(out)
        })
        .await
    }

    pub async fn indexes(
        conn: &DbConnection,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<crate::domain::IndexInfo>> {
        let schema = database.to_string();
        let table = table.to_string();
        with_conn(conn, move |c| {
            let sql = "SELECT i.index_name, i.uniqueness, ic.column_name, \
                              NVL(pk.is_primary, 0) \
                       FROM all_indexes i \
                       JOIN all_ind_columns ic ON ic.index_owner = i.owner \
                            AND ic.index_name = i.index_name \
                       LEFT JOIN ( \
                           SELECT owner, index_name, 1 AS is_primary FROM all_constraints \
                           WHERE constraint_type = 'P' \
                       ) pk ON pk.owner = i.owner AND pk.index_name = i.index_name \
                       WHERE i.table_owner = :1 AND i.table_name = :2 \
                       ORDER BY i.index_name, ic.column_position";
            let binds: Vec<&dyn ToDbValue> = vec![&schema, &table];
            let cursor = c.query(sql, &binds).map_err(ora_err)?;
            let mut out: Vec<crate::domain::IndexInfo> = Vec::new();
            for row in cursor {
                let row = row.map_err(ora_err)?;
                let name: String = row.get::<Option<String>>(0).ok().flatten().unwrap_or_default();
                let unique = row.get::<Option<String>>(1).ok().flatten().unwrap_or_default() == "UNIQUE";
                let column: String = row.get::<Option<String>>(2).ok().flatten().unwrap_or_default();
                let primary = row.get::<Option<i64>>(3).ok().flatten().unwrap_or(0) == 1;
                if out.last().map(|ix| ix.name == name).unwrap_or(false) {
                    out.last_mut().unwrap().columns.push(column);
                } else {
                    out.push(crate::domain::IndexInfo { name, columns: vec![column], unique, primary });
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn table_comment(conn: &DbConnection, database: &str, table: &str) -> AppResult<String> {
        let schema = database.to_string();
        let table = table.to_string();
        with_conn(conn, move |c| {
            let sql = "SELECT comments FROM all_tab_comments WHERE owner = :1 AND table_name = :2";
            let binds: Vec<&dyn ToDbValue> = vec![&schema, &table];
            let row = c.query_row(sql, &binds).map_err(ora_err)?;
            Ok(row.get::<Option<String>>(0).ok().flatten().unwrap_or_default())
        })
        .await
    }

    /// 一次事务里把所有改动写完；任一条失败整体回滚
    pub async fn apply_changes(
        conn: &DbConnection,
        database: &str,
        table: &str,
        changes: &[crate::domain::Change],
    ) -> AppResult<usize> {
        let schema = database.to_string();
        let table = table.to_string();
        let changes = changes.to_vec();
        with_conn(conn, move |c| {
            set_current_schema(c, &schema)?;
            let dialect = Dialect::Oracle;
            let mut applied = 0usize;
            let result = (|| -> AppResult<usize> {
                for (idx, change) in changes.iter().enumerate() {
                    let Some(stmt) = build_change_statement(dialect, &schema, &table, change) else {
                        continue;
                    };
                    let owned = optional_binds(&stmt.params);
                    let binds: Vec<&dyn ToDbValue> =
                        owned.iter().map(|v| v as &dyn ToDbValue).collect();
                    let rows = c
                        .execute(&stmt.sql, &binds)
                        .map_err(|e| change_failed(idx, &format!("执行失败：{e}")))?
                        .rows_affected();
                    if rows == 0 {
                        // 影响 0 行：区分「值没变」和「行已被别人改/删」
                        if let Some(check) = build_existence_check(dialect, &schema, &table, change) {
                            let owned = optional_binds(&check.params);
                            let binds: Vec<&dyn ToDbValue> =
                                owned.iter().map(|v| v as &dyn ToDbValue).collect();
                            let exists = c.query_row(&check.sql, &binds).is_ok();
                            if !exists {
                                return Err(change_failed(idx, "没有匹配到行：数据可能已被其他人修改或删除"));
                            }
                        }
                    }
                    applied += rows as usize;
                }
                Ok(applied)
            })();
            match result {
                Ok(n) => {
                    c.commit().map_err(ora_err)?;
                    Ok(n)
                }
                Err(e) => {
                    let _ = c.rollback();
                    Err(e)
                }
            }
        })
        .await
    }

    /// 执行计划：Oracle 得分两步——先 EXPLAIN PLAN，再从 DBMS_XPLAN 取结果
    pub async fn explain(
        conn: &DbConnection,
        database: Option<&str>,
        sql: &str,
    ) -> AppResult<ResultSet> {
        let schema = database.map(str::to_string);
        let sql = sql.to_string();
        with_conn(conn, move |c| {
            if let Some(schema) = schema.as_deref() {
                set_current_schema(c, schema)?;
            }
            // 清掉上一次同一个 statement_id 的结果，避免堆在 PLAN_TABLE 里
            let _ = c.execute(
                &format!("DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = '{PLAN_STMT_ID}'"),
                &[],
            );
            c.execute(
                &format!("EXPLAIN PLAN SET STATEMENT_ID = '{PLAN_STMT_ID}' FOR {sql}"),
                &[],
            )
            .map_err(ora_err)?;
            let display = format!(
                "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '{PLAN_STMT_ID}', 'TYPICAL'))"
            );
            fetch(c, &display, &[], 200)
        })
        .await
    }
}

fn ensure_semicolon(ddl: &str) -> String {
    if ddl.ends_with(';') {
        ddl.to_string()
    } else {
        format!("{ddl};")
    }
}

/// 结果集表头显示的类型名。
///
/// 我们的取值路径总是把 LOB 按文本 / 字节读出来，驱动这时候会把类型报成
/// LONG / LONG RAW（它报的是「这一趟怎么传过来的」）。直接显示成 LONG 会让人
/// 以为列是过时的 LONG 类型，所以这里按 LOB 显示；列的真实声明类型以「结构」页为准。
fn display_type(ty: &'static DbType, data_type: String) -> String {
    let n = ty.num();
    if n == oracledb::DB_TYPE_CLOB.num() {
        return "CLOB".to_string();
    }
    if n == oracledb::DB_TYPE_NCLOB.num() {
        return "NCLOB".to_string();
    }
    if n == oracledb::DB_TYPE_BLOB.num() {
        return "BLOB".to_string();
    }
    if n == oracledb::DB_TYPE_LONG.num() {
        return "CLOB".to_string();
    }
    if n == oracledb::DB_TYPE_LONG_NVARCHAR.num() {
        return "NCLOB".to_string();
    }
    if n == oracledb::DB_TYPE_LONG_RAW.num() {
        return "BLOB".to_string();
    }
    data_type
}

/// DBMS_METADATA 拿不到时（权限不足等）的兜底：用数据字典拼一份简化 DDL
fn manual_ddl(conn: &oracledb::Connection, schema: &str, table: &str) -> AppResult<String> {
    let sql = "SELECT c.column_name, c.data_type, c.data_length, c.char_length, \
                      c.data_precision, c.data_scale, c.nullable, c.data_default \
               FROM all_tab_columns c WHERE c.owner = :1 AND c.table_name = :2 \
               ORDER BY c.column_id";
    let binds: Vec<&dyn ToDbValue> = vec![&schema, &table];
    let cursor = conn.query(sql, &binds).map_err(ora_err)?;
    let mut lines: Vec<String> = Vec::new();
    for row in cursor {
        let row = row.map_err(ora_err)?;
        let name: String = row.get::<Option<String>>(0).ok().flatten().unwrap_or_default();
        let data_type: String = row.get::<Option<String>>(1).ok().flatten().unwrap_or_default();
        let length = row.get::<Option<i64>>(3).ok().flatten().unwrap_or(0);
        let precision = row.get::<Option<i64>>(4).ok().flatten().unwrap_or(0);
        let scale = row.get::<Option<i64>>(5).ok().flatten().unwrap_or(0);
        let nullable = row.get::<Option<String>>(6).ok().flatten().unwrap_or_default() == "Y";
        let default_value = row
            .get::<Option<String>>(7)
            .ok()
            .flatten()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        let ty = oracle_raw_type(&data_type, row.get::<Option<i64>>(2).ok().flatten().unwrap_or(0), length, precision, scale);
        let mut line = format!("  {} {}", Dialect::Oracle.quote(&name), ty);
        if let Some(default) = default_value {
            line.push_str(&format!(" DEFAULT {default}"));
        }
        if !nullable {
            line.push_str(" NOT NULL");
        }
        lines.push(line);
    }
    Ok(ensure_semicolon(&format!(
        "CREATE TABLE {}.{} (\n{}\n)",
        Dialect::Oracle.quote(schema),
        Dialect::Oracle.quote(table),
        lines.join(",\n")
    )))
}

/// 把数据字典里的类型 + 长度拼成可读类型，例如 VARCHAR2(100) / NUMBER(10,2)
fn oracle_raw_type(
    data_type: &str,
    data_length: i64,
    char_length: i64,
    precision: i64,
    scale: i64,
) -> String {
    let upper = data_type.to_ascii_uppercase();
    // data_type 里带括号的（TIMESTAMP(6)、INTERVAL DAY(3) TO SECOND(6)）原样用
    if upper.contains('(') || upper.contains(' ') || upper.contains("RAW") {
        return upper;
    }
    match upper.as_str() {
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" => {
            let len = if char_length > 0 { char_length } else { data_length };
            format!("{upper}({len})")
        }
        "NUMBER" | "DECIMAL" | "NUMERIC" => {
            if precision > 0 {
                format!("{upper}({precision},{scale})")
            } else {
                upper
            }
        }
        _ => upper,
    }
}

/// 归一化成前端 fieldKind 认的类型名
fn normalize_type(data_type: &str) -> String {
    let t = data_type.to_ascii_uppercase();
    if t.starts_with("TIMESTAMP") {
        return "timestamp".to_string();
    }
    match t.as_str() {
        "DATE" => "date".to_string(),
        "NUMBER" | "FLOAT" | "DECIMAL" | "NUMERIC" | "INTEGER" | "BINARY_FLOAT" | "BINARY_DOUBLE" => {
            "number".to_string()
        }
        "BLOB" | "RAW" | "LONG RAW" | "BFILE" => "blob".to_string(),
        "CLOB" | "NCLOB" | "LONG" | "XMLTYPE" => "text".to_string(),
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" | "ROWID" | "UROWID" => "varchar".to_string(),
        _ => t.to_ascii_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_oracle_connect_strings() {
        let mut config = crate::domain::ConnectionConfig {
            id: "t".into(),
            name: "t".into(),
            host: "db".into(),
            port: 1521,
            username: "scott".into(),
            database: Some("ORCLPDB1".into()),
            flavor: crate::domain::DbFlavor::Oracle,
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
        // 默认按服务名
        assert_eq!(connect_string(&config, "db", 1521).unwrap(), "db:1521/ORCLPDB1");
        // SID 走冒号形态
        config.oracle_conn_type = Some("sid".into());
        let sid = connect_string(&config, "db", 1521).unwrap();
        assert!(sid.contains("(SID=ORCLPDB1)"), "{sid}");
        assert!(sid.starts_with("(DESCRIPTION="), "{sid}");
        config.database = None;
        assert!(connect_string(&config, "db", 1521).is_err());
    }

    #[test]
    fn normalizes_oracle_types() {
        assert_eq!(normalize_type("VARCHAR2"), "varchar");
        assert_eq!(normalize_type("NUMBER"), "number");
        assert_eq!(normalize_type("TIMESTAMP(6)"), "timestamp");
        assert_eq!(normalize_type("CLOB"), "text");
        assert_eq!(oracle_raw_type("VARCHAR2", 100, 100, 0, 0), "VARCHAR2(100)");
        assert_eq!(oracle_raw_type("NUMBER", 22, 0, 10, 2), "NUMBER(10,2)");
        assert_eq!(oracle_raw_type("DATE", 7, 0, 0, 0), "DATE");
    }

    #[test]
    fn detects_query_statements() {
        assert!(is_query_sql("select 1 from dual"));
        assert!(is_query_sql("  WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(is_query_sql("-- 注释\nSELECT 1 FROM DUAL"));
        assert!(is_query_sql("/* 注释 */ select 1 from dual"));
        assert!(!is_query_sql("CREATE TABLE t (a NUMBER)"));
        assert!(!is_query_sql("BEGIN NULL; END;"));
    }

    /// 不发连接，只验证驱动接受我们要用的两种连接串（服务名 / SID）
    #[test]
    fn driver_accepts_our_connect_strings() {
        let sid_descriptor =
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=db.example.com)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))";
        for cs in ["db.example.com:1521/ORCLPDB1", sid_descriptor] {
            let cfg = oracledb::Config::default()
                .set_credentials("scott", "tiger")
                .set_connect_string(cs)
                .unwrap_or_else(|e| panic!("{cs} 不被驱动接受：{e}"));
            let descriptor = cfg.get_connect_descriptor();
            assert!(!descriptor.is_empty(), "{cs} 解析出来是空的");
        }
    }

    /// 诊断用：列出某个 schema 里的表（联调「执行到库」时确认结果）
    /// `MYCO_ORA_PASSWORD=... cargo test --lib -- --ignored --nocapture oracle_live_list`
    #[tokio::test]
    #[ignore = "需要真实 Oracle 实例"]
    async fn oracle_live_list_tables() {
        let cfg = ConnectionConfig {
            id: "list".into(),
            name: "list".into(),
            host: std::env::var("MYCO_ORA_HOST").unwrap_or_else(|_| "10.25.77.160".into()),
            port: std::env::var("MYCO_ORA_PORT").unwrap_or_else(|_| "8165".into()).parse().unwrap(),
            username: std::env::var("MYCO_ORA_USER").unwrap_or_else(|_| "appuser".into()),
            database: Some(std::env::var("MYCO_ORA_SERVICE").unwrap_or_else(|_| "XEPDB1".into())),
            flavor: crate::domain::DbFlavor::Oracle,
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
            oracle_conn_type: Some("service".into()),
            oracle_role: None,
        };
        let password = std::env::var("MYCO_ORA_PASSWORD").expect("需要 MYCO_ORA_PASSWORD");
        let conn = OracleDriver::connect(&cfg, &password, None).await.expect("连接失败");
        let schema = cfg.username.to_ascii_uppercase();
        let tables = OracleDriver::list_tables(&conn, &schema).await.expect("列表失败");
        println!(
            "{schema} 里现在有 {} 张表：{}",
            tables.len(),
            tables.iter().map(|t| t.name.clone()).collect::<Vec<_>>().join(", ")
        );
        let graph = OracleDriver::schema_graph(&conn, &schema).await.expect("取结构失败");
        println!("结构快照：{} 张表 / {} 条外键", graph.tables.len(), graph.edges.len());
        for t in &graph.tables {
            let cols: Vec<String> =
                t.columns.iter().map(|c| format!("{} {}", c.name, c.raw_type)).collect();
            println!("  {} ({})", t.name, cols.join(", "));
        }
    }

    /// 探针：固定 NLS 之后，Oracle 到底接受哪种日期时间字符串（决定编辑回写能不能用）
    #[tokio::test]
    #[ignore = "需要真实 Oracle 实例"]
    async fn oracle_live_datetime_inputs() {
        let cfg = ConnectionConfig {
            id: "probe".into(),
            name: "probe".into(),
            host: std::env::var("MYCO_ORA_HOST").unwrap_or_else(|_| "10.25.77.160".into()),
            port: std::env::var("MYCO_ORA_PORT").unwrap_or_else(|_| "8165".into()).parse().unwrap(),
            username: std::env::var("MYCO_ORA_USER").unwrap_or_else(|_| "appuser".into()),
            database: Some(std::env::var("MYCO_ORA_SERVICE").unwrap_or_else(|_| "XEPDB1".into())),
            flavor: crate::domain::DbFlavor::Oracle,
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
            oracle_conn_type: Some("service".into()),
            oracle_role: None,
        };
        let password = std::env::var("MYCO_ORA_PASSWORD").expect("需要设置 MYCO_ORA_PASSWORD 环境变量");
        let conn = OracleDriver::connect(&cfg, &password, None).await.expect("连接失败");
        with_conn(&conn, |c| {
            for (label, sql) in [
                ("DATE 只给日期", "SELECT CAST('2024-01-02' AS DATE) FROM DUAL"),
                ("DATE 给到秒", "SELECT CAST('2024-01-02 03:04:05' AS DATE) FROM DUAL"),
                ("TIMESTAMP 给到秒", "SELECT CAST('2024-01-02 03:04:05' AS TIMESTAMP) FROM DUAL"),
                ("TIMESTAMP 带小数秒", "SELECT CAST('2024-01-02 03:04:05.123' AS TIMESTAMP) FROM DUAL"),
                ("TO_DATE 带小数秒", "SELECT TO_DATE('2024-01-02 03:04:05.123','YYYY-MM-DD HH24:MI:SS.FF') FROM DUAL"),
                ("TO_TIMESTAMP 无小数秒", "SELECT TO_TIMESTAMP('2024-01-02 03:04:05','YYYY-MM-DD HH24:MI:SS.FF') FROM DUAL"),
            ] {
                match c.query_row(sql, &[]) {
                    Ok(row) => {
                        let v = row.get::<Option<OracleTimestamp>>(0).ok().flatten();
                        match v {
                            Some(t) => println!(
                                "{label}: OK → {}",
                                format_timestamp(
                                    &t,
                                    if label.starts_with("DATE") {
                                        oracledb::DB_TYPE_DATE
                                    } else {
                                        oracledb::DB_TYPE_TIMESTAMP
                                    }
                                )
                            ),
                            None => println!("{label}: 返回 NULL"),
                        }
                    }
                    Err(e) => println!("{label}: 失败 → {e}"),
                }
            }
            for (label, sql) in [
                ("NLS_DATE_FORMAT", "SELECT value FROM nls_session_parameters WHERE parameter = 'NLS_DATE_FORMAT'"),
                ("NLS_TIMESTAMP_FORMAT", "SELECT value FROM nls_session_parameters WHERE parameter = 'NLS_TIMESTAMP_FORMAT'"),
            ] {
                if let Ok(row) = c.query_row(sql, &[]) {
                    println!("{label} = {:?}", row.get::<Option<String>>(0).ok().flatten());
                }
            }
            Ok(())
        })
        .await
        .expect("探针失败");
    }

    /// 边界场景：日期时间回写、无主键表的空值定位、BLOB/RAW、分页、外键、视图 DDL
    #[tokio::test]
    #[ignore = "需要真实 Oracle 实例"]
    async fn oracle_live_edge_cases() {
        use crate::domain::{Change, ColumnValue, FilterSpec};

        let cfg = ConnectionConfig {
            id: "edge".into(),
            name: "edge".into(),
            host: std::env::var("MYCO_ORA_HOST").unwrap_or_else(|_| "10.25.77.160".into()),
            port: std::env::var("MYCO_ORA_PORT").unwrap_or_else(|_| "8165".into()).parse().unwrap(),
            username: std::env::var("MYCO_ORA_USER").unwrap_or_else(|_| "appuser".into()),
            database: Some(std::env::var("MYCO_ORA_SERVICE").unwrap_or_else(|_| "XEPDB1".into())),
            flavor: crate::domain::DbFlavor::Oracle,
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
            oracle_conn_type: Some("service".into()),
            oracle_role: None,
        };
        let password = std::env::var("MYCO_ORA_PASSWORD").expect("需要设置 MYCO_ORA_PASSWORD 环境变量");
        let conn = OracleDriver::connect(&cfg, &password, None).await.expect("连接失败");
        let schema = cfg.username.to_ascii_uppercase();

        async fn ddl(conn: &DbConnection, sql: String) {
            OracleDriver::query(conn, None, &sql, 1).await.unwrap_or_else(|e| panic!("{sql} → {e}"));
        }
        let cell = |rs: &ResultSet, r: usize, c: usize| rs.rows[r][c].clone();

        // 准备：主表 / 子表（外键）/ 视图 / 无主键表
        for drop in [
            "DROP VIEW MYCO_VIEW",
            "DROP TABLE MYCO_CHILD PURGE",
            "DROP TABLE MYCO_EDGE PURGE",
            "DROP TABLE MYCO_NOPK PURGE",
        ] {
            let _ = OracleDriver::query(&conn, None, &format!("{drop}"), 1).await;
            let _ = drop;
        }
        ddl(
            &conn,
            format!(
                "CREATE TABLE {schema}.MYCO_EDGE (\
                   ID NUMBER(10) PRIMARY KEY, \
                   D DATE, \
                   TS TIMESTAMP(6), \
                   B BLOB, \
                   R RAW(16), \
                   N NUMBER(10,2), \
                   V VARCHAR2(50))"
            ),
        )
        .await;
        ddl(
            &conn,
            format!(
                "CREATE TABLE {schema}.MYCO_CHILD (ID NUMBER(10) PRIMARY KEY, \
                 P_ID NUMBER(10) REFERENCES {schema}.MYCO_EDGE(ID))"
            ),
        )
        .await;
        ddl(&conn, format!("CREATE VIEW {schema}.MYCO_VIEW AS SELECT ID, D FROM {schema}.MYCO_EDGE")).await;
        ddl(&conn, format!("CREATE TABLE {schema}.MYCO_NOPK (K VARCHAR2(20), V VARCHAR2(20))")).await;

        // 250 行，验证分页（OFFSET/FETCH）与总数
        ddl(
            &conn,
            format!(
                "INSERT INTO {schema}.MYCO_EDGE (ID, N, V) \
                 SELECT LEVEL, LEVEL / 100, 'row-' || LEVEL FROM DUAL CONNECT BY LEVEL <= 250"
            ),
        )
        .await;
        let (sql1, p1) = crate::service::query::build_preview_sql(
            Dialect::Oracle, None, &schema, "MYCO_EDGE", &[], Some("ID"), Some("asc"), 100, 0,
        );
        let page1 = OracleDriver::query_bound(&conn, Some(&schema), &sql1, p1, 100).await.unwrap();
        let (sql3, p3) = crate::service::query::build_preview_sql(
            Dialect::Oracle, None, &schema, "MYCO_EDGE", &[], Some("ID"), Some("asc"), 100, 200,
        );
        let page3 = OracleDriver::query_bound(&conn, Some(&schema), &sql3, p3, 100).await.unwrap();
        let (csql, cp) = crate::service::query::build_preview_count_sql(Dialect::Oracle, None, &schema, "MYCO_EDGE", &[]);
        let total = OracleDriver::count_bound(&conn, Some(&schema), &csql, cp).await.unwrap();
        println!(
            "page1 {} 行 [{}..{}]，page3 {} 行 [{}..{}]，总数 {total}",
            page1.rows.len(),
            cell(&page1, 0, 0).to_text(),
            cell(&page1, page1.rows.len() - 1, 0).to_text(),
            page3.rows.len(),
            cell(&page3, 0, 0).to_text(),
            cell(&page3, page3.rows.len() - 1, 0).to_text(),
        );
        assert_eq!(total, 250);
        assert_eq!(page1.rows.len(), 100);
        assert_eq!(cell(&page1, 0, 0).to_text(), "1");
        assert_eq!(page3.rows.len(), 50);
        assert_eq!(cell(&page3, 0, 0).to_text(), "201");
        assert_eq!(cell(&page3, 49, 0).to_text(), "250");

        // max_rows 截断
        let capped = OracleDriver::query(&conn, None, &format!("SELECT ID FROM {schema}.MYCO_EDGE"), 10)
            .await
            .unwrap();
        assert!(capped.truncated, "超过上限应该标截断");
        assert_eq!(capped.rows.len(), 10);

        // 数字精度：NUMBER(10,2) 要保留十进制文本
        let n = cell(&page1, 0, 5);
        println!("NUMBER 值 = {n:?}");
        assert_eq!(n.to_text(), "0.01");

        // DATE / TIMESTAMP 回写：先写，再按读出来的文本原样回写一遍（模拟界面编辑）
        let upd = |col: &str, val: &str| {
            vec![Change::Update {
                pk: vec![ColumnValue { column: "ID".into(), value: Some("1".into()) }],
                values: vec![ColumnValue { column: col.into(), value: Some(val.into()) }],
                original: vec![],
            }]
        };
        for (col, val) in [
            ("D", "2024-01-02"),                    // 日期控件给的形态
            ("D", "2024-01-02 03:04:05"),           // 完整形态
            ("TS", "2024-01-02 03:04:05"),          // TIMESTAMP 无小数秒
            ("TS", "2024-01-02 03:04:05.123456"),   // 带小数秒
        ] {
            let res = OracleDriver::apply_changes(&conn, &schema, "MYCO_EDGE", &upd(col, val)).await;
            println!("写 {col} = {val} → {res:?}");
            res.unwrap_or_else(|e| panic!("写入 {col}={val} 失败：{e}"));
        }
        let read = OracleDriver::query(
            &conn,
            None,
            &format!("SELECT D, TS FROM {schema}.MYCO_EDGE WHERE ID = 1"),
            5,
        )
        .await
        .unwrap();
        let d_text = cell(&read, 0, 0).to_text();
        let ts_text = cell(&read, 0, 1).to_text();
        println!("读回来 D = {d_text} / TS = {ts_text}");
        assert_eq!(d_text, "2024-01-02 03:04:05");
        assert_eq!(ts_text, "2024-01-02 03:04:05.123456");

        // 把读出来的文本当 original 再改一次：证明「显示格式」能当绑定值用
        let round_trip = vec![Change::Update {
            pk: vec![ColumnValue { column: "ID".into(), value: Some("1".into()) }],
            values: vec![ColumnValue { column: "TS".into(), value: Some(ts_text.clone()) }],
            original: vec![ColumnValue { column: "TS".into(), value: Some(ts_text.clone()) }],
        }];
        OracleDriver::apply_changes(&conn, &schema, "MYCO_EDGE", &round_trip)
            .await
            .expect("按显示格式回写应该成功");

        // BLOB / RAW
        ddl(
            &conn,
            format!(
                "UPDATE {schema}.MYCO_EDGE SET B = HEXTORAW('DEADBEEF'), R = HEXTORAW('00FF10') WHERE ID = 1"
            ),
        )
        .await;
        let bin = OracleDriver::query(
            &conn,
            None,
            &format!("SELECT B, R FROM {schema}.MYCO_EDGE WHERE ID = 1"),
            5,
        )
        .await
        .unwrap();
        println!("B = {:?} / R = {:?}", bin.rows[0][0], bin.rows[0][1]);
        println!(
            "结果集表头类型 = {:?}",
            bin.columns.iter().map(|c| format!("{}:{}", c.name, c.type_name)).collect::<Vec<_>>()
        );
        assert_eq!(bin.rows[0][0], Value::Bytes(vec![0xDE, 0xAD, 0xBE, 0xEF]));
        assert_eq!(bin.rows[0][1], Value::Bytes(vec![0x00, 0xFF, 0x10]));

        // 无主键表 + 定位列是 NULL：DECODE 空值安全比较要能定位到那一行
        ddl(&conn, format!("INSERT INTO {schema}.MYCO_NOPK (K, V) VALUES (NULL, 'a')")).await;
        ddl(&conn, format!("INSERT INTO {schema}.MYCO_NOPK (K, V) VALUES ('x', 'b')")).await;
        let null_edit = vec![Change::Update {
            pk: vec![ColumnValue { column: "K".into(), value: None }],
            values: vec![ColumnValue { column: "V".into(), value: Some("a2".into()) }],
            original: vec![ColumnValue { column: "V".into(), value: Some("a".into()) }],
        }];
        let applied = OracleDriver::apply_changes(&conn, &schema, "MYCO_NOPK", &null_edit)
            .await
            .expect("空值定位列应该能更新");
        println!("空值定位列更新影响 {applied} 行");
        assert_eq!(applied, 1);
        let nopk = OracleDriver::query(&conn, None, &format!("SELECT K, V FROM {schema}.MYCO_NOPK"), 10)
            .await
            .unwrap();
        let null_row = nopk
            .rows
            .iter()
            .find(|r| r[0] == Value::Null)
            .expect("应该还有 K 为 NULL 的那行");
        assert_eq!(null_row[1], Value::Str("a2".into()), "应该改到 K 为 NULL 的那行");
        let other_row = nopk.rows.iter().find(|r| r[0] == Value::Str("x".into())).expect("另一行还在");
        assert_eq!(other_row[1], Value::Str("b".into()), "另一行不该被改");

        // 外键 / 视图 DDL / 索引
        let fks = OracleDriver::foreign_keys(&conn, &schema, "MYCO_CHILD").await.unwrap();
        println!("foreign_keys = {fks:?}");
        assert_eq!(fks.len(), 1);
        assert_eq!(fks[0].column, "P_ID");
        assert_eq!(fks[0].ref_table, "MYCO_EDGE");
        assert_eq!(fks[0].ref_column, "ID");
        let view_ddl = OracleDriver::table_ddl(&conn, &schema, "MYCO_VIEW").await.unwrap();
        println!("view ddl head = {}", view_ddl.lines().next().unwrap_or_default());
        // 视图必须拿到 CREATE ... VIEW，而不是视图底下那张伪表的 CREATE TABLE
        let head = view_ddl.lines().next().unwrap_or_default().to_uppercase();
        assert!(head.contains("CREATE"), "{head}");
        assert!(head.contains("VIEW") && !head.contains("CREATE TABLE"), "{head}");
        let idx = OracleDriver::indexes(&conn, &schema, "MYCO_EDGE").await.unwrap();
        assert!(idx.iter().any(|i| i.primary && i.columns == vec!["ID".to_string()]), "{idx:?}");

        // ER 图数据：MYCO_CHILD.P_ID 是真实外键，必须出现连线；MYCO_NOPK 没有任何外键
        let graph = OracleDriver::schema_graph(&conn, &schema).await.expect("取 ER 图数据失败");
        let edge = graph
            .edges
            .iter()
            .find(|e| e.from_table == "MYCO_CHILD")
            .expect("应该有 MYCO_CHILD 的外键连线");
        println!("ER 边 = {edge:?}");
        assert_eq!(edge.to_table, "MYCO_EDGE");
        assert_eq!(edge.to_column, "ID");
        let child = graph.tables.iter().find(|t| t.name == "MYCO_CHILD").expect("缺 MYCO_CHILD");
        assert!(child.columns.iter().any(|c| c.name == "P_ID" && c.foreign_key));
        let nopk = graph.tables.iter().find(|t| t.name == "MYCO_NOPK").expect("缺 MYCO_NOPK");
        assert!(nopk.columns.iter().all(|c| !c.foreign_key), "没约束的表不该有外键列");
        assert!(
            graph.edges.iter().all(|e| e.from_table == "MYCO_CHILD"),
            "只画真实外键：{:?}",
            graph.edges
        );

        // 筛选：数字列用字符串绑定要能比较
        let filters = vec![FilterSpec { column: "N".into(), operator: ">".into(), value: "2".into() }];
        let (fsql, fp) =
            crate::service::query::build_preview_sql(Dialect::Oracle, None, &schema, "MYCO_EDGE", &filters, None, None, 10, 0);
        println!("数字筛选 sql = {fsql} / {fp:?}");
        let frows = OracleDriver::query_bound(&conn, Some(&schema), &fsql, fp, 10).await.unwrap();
        assert_eq!(frows.rows.len(), 10);

        // 收尾
        ddl(&conn, format!("DROP VIEW {schema}.MYCO_VIEW")).await;
        ddl(&conn, format!("DROP TABLE {schema}.MYCO_CHILD PURGE")).await;
        ddl(&conn, format!("DROP TABLE {schema}.MYCO_EDGE PURGE")).await;
        ddl(&conn, format!("DROP TABLE {schema}.MYCO_NOPK PURGE")).await;
    }

    /// 连真库的冒烟测试：默认不跑，手动执行
    /// `cargo test --lib -- --ignored --nocapture oracle_live`
    /// 账号/地址可以用 MYCO_ORA_HOST / _PORT / _USER / _PASSWORD / _SERVICE 覆盖。
    #[tokio::test]
    #[ignore = "需要真实 Oracle 实例"]
    async fn oracle_live_smoke() {
        use crate::domain::{Change, ColumnValue, FilterSpec};

        fn env_or(key: &str, default: &str) -> String {
            std::env::var(key).unwrap_or_else(|_| default.to_string())
        }

        fn config(id: &str, user: &str, service: &str, conn_type: &str, role: Option<&str>) -> ConnectionConfig {
            ConnectionConfig {
                id: id.into(),
                name: id.into(),
                host: env_or("MYCO_ORA_HOST", "10.25.77.160"),
                port: env_or("MYCO_ORA_PORT", "8165").parse().unwrap(),
                username: user.into(),
                database: Some(service.into()),
                flavor: crate::domain::DbFlavor::Oracle,
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
                oracle_conn_type: Some(conn_type.into()),
                oracle_role: role.map(str::to_string),
            }
        }

        let password = env_or("MYCO_ORA_PASSWORD", "");
        let service = env_or("MYCO_ORA_SERVICE", "XEPDB1");
        let user = env_or("MYCO_ORA_USER", "appuser");

        // 1) 普通用户连 PDB（服务名）
        let cfg = config("live-pdb", &user, &service, "service", None);
        let conn = OracleDriver::connect(&cfg, &password, None)
            .await
            .expect("连接 PDB 失败");
        let schema = user.to_ascii_uppercase();
        let dbs = OracleDriver::list_databases(&conn).await.expect("列 schema 失败");
        println!("schemas({}) = {:?}", dbs.len(), &dbs[..dbs.len().min(12)]);
        assert!(dbs.iter().any(|d| d == &schema), "自己的 schema 应该在列表里：{schema}");

        // 2) 建一张临时表（identity + 注释 + 中文）
        let table = "MYCO_DRV_TEST";
        let _ = OracleDriver::query(&conn, None, &format!("DROP TABLE {schema}.{table}"), 1).await;
        OracleDriver::query(
            &conn,
            None,
            &format!(
                "CREATE TABLE {schema}.{table} (\
                   ID NUMBER(10) GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, \
                   NAME VARCHAR2(100), \
                   CREATED_AT DATE, \
                   NOTE CLOB)"
            ),
            1,
        )
        .await
        .expect("建表失败");
        OracleDriver::query(
            &conn,
            None,
            &format!("COMMENT ON TABLE {schema}.{table} IS '驱动自测表'"),
            1,
        )
        .await
        .expect("表注释失败");
        OracleDriver::query(
            &conn,
            None,
            &format!("COMMENT ON COLUMN {schema}.{table}.NAME IS '名称（中文）'"),
            1,
        )
        .await
        .expect("列注释失败");

        let tables = OracleDriver::list_tables(&conn, &schema).await.expect("列表失败");
        assert!(tables.iter().any(|t| t.name == table), "临时表应该在表列表里");

        let cols = OracleDriver::list_columns(&conn, &schema, table).await.expect("列字段失败");
        let id_col = cols.iter().find(|c| c.name == "ID").expect("缺 ID 列");
        assert!(id_col.primary_key, "ID 应该是主键：{id_col:?}");
        assert!(id_col.auto_increment, "ID 应该是 identity：{id_col:?}");
        let name_col = cols.iter().find(|c| c.name == "NAME").expect("缺 NAME 列");
        assert_eq!(name_col.comment, "名称（中文）");
        assert_eq!(name_col.data_type, "varchar");
        println!("columns = {:?}", cols.iter().map(|c| (&c.name, &c.raw_type, &c.data_type)).collect::<Vec<_>>());

        // 3) 写数据（中文 / NULL / SYSDATE），再读回来
        for (name, note) in [("张三", "'中文备注'"), ("李四", "NULL"), ("wang wu", "'mixed 中英'")] {
            OracleDriver::query(
                &conn,
                None,
                &format!(
                    "INSERT INTO {schema}.{table} (NAME, CREATED_AT, NOTE) VALUES ('{name}', SYSDATE, {note})"
                ),
                1,
            )
            .await
            .expect("插入失败");
        }
        let rs = OracleDriver::query(
            &conn,
            None,
            &format!("SELECT ID, NAME, CREATED_AT, NOTE FROM {schema}.{table} ORDER BY ID"),
            100,
        )
        .await
        .expect("查询失败");
        println!("result columns = {:?}", rs.columns.iter().map(|c| &c.type_name).collect::<Vec<_>>());
        println!("result rows = {:?}", rs.rows);
        assert_eq!(rs.rows.len(), 3);
        assert_eq!(rs.rows[0][1], Value::Str("张三".into()));
        assert_eq!(rs.rows[1][3], Value::Null);
        assert!(matches!(rs.rows[0][2], Value::DateTime(_)), "DATE 应该映射成 datetime");

        // 4) 浏览路径：筛选 + 排序 + 分页 + 总数
        let filters = vec![FilterSpec { column: "NAME".into(), operator: "like".into(), value: "张".into() }];
        let (sql, params) = crate::service::query::build_preview_sql(
            Dialect::Oracle,
            None,
            &schema,
            table,
            &filters,
            Some("ID"),
            Some("desc"),
            50,
            0,
        );
        println!("browse sql = {sql} / {params:?}");
        let page = OracleDriver::query_bound(&conn, Some(&schema), &sql, params.clone(), 50)
            .await
            .expect("筛选分页失败");
        assert_eq!(page.rows.len(), 1);
        let (count_sql, count_params) = crate::service::query::build_preview_count_sql(
            Dialect::Oracle,
            None,
            &schema,
            table,
            &filters,
        );
        let total = OracleDriver::count_bound(&conn, Some(&schema), &count_sql, count_params)
            .await
            .expect("计数失败");
        assert_eq!(total, 1);

        // 5) 结构信息
        let ddl = OracleDriver::table_ddl(&conn, &schema, table).await.expect("取 DDL 失败");
        println!("ddl head = {}", ddl.lines().next().unwrap_or_default());
        assert!(ddl.to_uppercase().contains(table));
        let comment = OracleDriver::table_comment(&conn, &schema, table).await.expect("表注释读取失败");
        assert_eq!(comment, "驱动自测表");
        let indexes = OracleDriver::indexes(&conn, &schema, table).await.expect("索引失败");
        println!("indexes = {indexes:?}");
        assert!(indexes.iter().any(|i| i.primary), "应该有主键索引");
        let schema_tables = OracleDriver::schema_tables(&conn, &schema).await.expect("schema 概览失败");
        assert!(schema_tables.iter().any(|t| t.name == table));
        let _ = OracleDriver::foreign_keys(&conn, &schema, table).await.expect("外键失败");

        // 6) 编辑提交（事务）；失败要整体回滚
        let changes = vec![
            Change::Insert {
                values: vec![
                    ColumnValue { column: "NAME".into(), value: Some("新增行".into()) },
                    ColumnValue { column: "NOTE".into(), value: None },
                ],
            },
            Change::Update {
                pk: vec![ColumnValue { column: "ID".into(), value: Some("1".into()) }],
                values: vec![ColumnValue { column: "NAME".into(), value: Some("张三改".into()) }],
                original: vec![ColumnValue { column: "NAME".into(), value: Some("张三".into()) }],
            },
            Change::Delete {
                pk: vec![ColumnValue { column: "ID".into(), value: Some("2".into()) }],
            },
        ];
        let applied = OracleDriver::apply_changes(&conn, &schema, table, &changes)
            .await
            .expect("提交失败");
        assert_eq!(applied, 3);
        let after = OracleDriver::query(
            &conn,
            None,
            &format!("SELECT NAME FROM {schema}.{table} ORDER BY ID"),
            100,
        )
        .await
        .expect("复查失败");
        let names: Vec<String> = after
            .rows
            .iter()
            .map(|r| match &r[0] {
                Value::Str(s) => s.clone(),
                other => format!("{other:?}"),
            })
            .collect();
        println!("names after commit = {names:?}");
        assert!(names.contains(&"张三改".to_string()), "改名没生效：{names:?}");
        assert!(!names.contains(&"李四".to_string()), "删除没生效：{names:?}");
        assert!(names.contains(&"新增行".to_string()), "新增没生效：{names:?}");

        // 乐观并发：原始值对不上 → 报错且回滚
        let conflict = vec![Change::Update {
            pk: vec![ColumnValue { column: "ID".into(), value: Some("1".into()) }],
            values: vec![ColumnValue { column: "NAME".into(), value: Some("不该落库".into()) }],
            original: vec![ColumnValue { column: "NAME".into(), value: Some("不是当前值".into()) }],
        }];
        let err = OracleDriver::apply_changes(&conn, &schema, table, &conflict).await;
        assert!(err.is_err(), "原始值对不上应该报错");
        println!("conflict error = {}", err.unwrap_err());
        let still = OracleDriver::query(
            &conn,
            None,
            &format!("SELECT NAME FROM {schema}.{table} WHERE ID = 1"),
            10,
        )
        .await
        .expect("复查失败");
        assert_eq!(still.rows[0][0], Value::Str("张三改".into()), "冲突的那次改动不该落库");

        // 7) 执行计划
        let plan = OracleDriver::explain(&conn, Some(&schema), &format!("SELECT * FROM {table} WHERE ID = 1"))
            .await
            .expect("执行计划失败");
        let plan_text = plan
            .rows
            .iter()
            .map(|r| match &r[0] {
                Value::Str(s) => s.clone(),
                other => format!("{other:?}"),
            })
            .collect::<Vec<_>>()
            .join("\n");
        println!("plan:\n{plan_text}");
        assert!(plan_text.contains("SELECT STATEMENT"), "计划里应该有 SELECT STATEMENT");

        // 收尾
        OracleDriver::query(&conn, None, &format!("DROP TABLE {schema}.{table} PURGE"), 1)
            .await
            .expect("删表失败");

        // 8) SID + SYSDBA 连 CDB（验证连接描述符与特权认证）
        let sys_cfg = config("live-cdb", "SYS", "XE", "sid", Some("SYSDBA"));
        match OracleDriver::connect(&sys_cfg, &password, None).await {
            Ok(sys_conn) => {
                let schemas = OracleDriver::list_databases(&sys_conn).await.expect("CDB 列 schema 失败");
                println!("CDB schemas = {}", schemas.len());
                assert!(!schemas.is_empty());
            }
            Err(e) => println!("SYSDBA/SID 连接跳过：{e}"),
        }
    }
}
