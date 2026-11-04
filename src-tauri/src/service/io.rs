use crate::domain::{Change, ColumnValue, FilterSpec};
use crate::error::{AppError, AppResult};
use crate::service::connection_manager::ConnectionManager;
use crate::service::query::{build_preview_sql, MAX_ROWS};
use serde::{Deserialize, Serialize};
use std::io::Write;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportColumn {
    pub file_column: String,
    pub table_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub delimiter: String,
    pub has_header: bool,
    pub columns: Vec<String>,
    pub sample: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportReport {
    pub imported: u64,
    pub failed: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlFileReport {
    pub executed: u64,
    pub total: u64,
}

fn decode_bytes(bytes: Vec<u8>) -> String {
    let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes[3..].to_vec()
    } else {
        bytes
    };
    match String::from_utf8(bytes.clone()) {
        Ok(s) => s,
        Err(_) => encoding_rs::GBK.decode(&bytes).0.into_owned(),
    }
}

fn detect_delimiter(text: &str) -> u8 {
    for &d in &[b',', b';', b'\t'] {
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(d)
            .has_headers(false)
            .flexible(true)
            .from_reader(text.as_bytes());
        let counts: Vec<usize> = rdr
            .records()
            .take(20)
            .filter_map(|r| r.ok().map(|r| r.len()))
            .collect();
        if counts.len() >= 2 && counts.iter().all(|c| *c == counts[0]) && counts[0] >= 1 {
            return d;
        }
    }
    b','
}

fn parse_csv(text: &str, delimiter: u8) -> Vec<Vec<String>> {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    rdr.records().filter_map(|r| r.ok().map(|r| r.iter().map(|s| s.to_string()).collect())).collect()
}

fn split_sql_statements(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut i = 0;
    let chars: Vec<char> = text.chars().collect();
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\'' || ch == '"' || ch == '`' {
            let quote = ch;
            buf.push(ch);
            i += 1;
            while i < chars.len() {
                buf.push(chars[i]);
                if quote != '`' && chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                    buf.push(chars[i]);
                } else if chars[i] == quote {
                    if i + 1 < chars.len() && chars[i + 1] == quote {
                        i += 1;
                        buf.push(chars[i]);
                    } else {
                        break;
                    }
                }
                i += 1;
            }
        } else if ch == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if ch == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && chars.get(i + 1) == Some(&'*') {
            buf.push(' ');
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else if ch == ';' {
            let s = buf.trim().to_string();
            if !s.is_empty() {
                out.push(s);
            }
            buf.clear();
        } else {
            buf.push(ch);
        }
        i += 1;
    }
    let tail = buf.trim().to_string();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// 整表导出的目标格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

impl ExportFormat {
    pub fn parse(s: &str) -> AppResult<Self> {
        match s.to_ascii_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            "sql" => Ok(Self::Sql),
            other => Err(AppError::Message(format!("不支持的导出格式：{other}"))),
        }
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// `Value` → JSON 片段：数字/布尔保持原生类型，其余按字符串，NULL 为 null。
fn json_value(v: &crate::domain::Value) -> String {
    use crate::domain::Value as V;
    match v {
        V::Null => "null".to_string(),
        V::Bool(b) => b.to_string(),
        V::Int(_) | V::UInt(_) => v.to_text(),
        V::Float(f) => {
            if f.is_finite() {
                f.to_string()
            } else {
                "null".to_string()
            }
        }
        V::Decimal(s) => {
            // 十进制串本身是合法的 JSON 数字，原样输出；否则退回字符串
            if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) {
                s.clone()
            } else {
                serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
            }
        }
        V::Bytes(b) => serde_json::to_string(&to_hex(b)).unwrap_or_else(|_| "\"\"".into()),
        V::Str(s) | V::Date(s) | V::Time(s) | V::DateTime(s) | V::Json(s) => {
            serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
        }
    }
}

/// `Value` → SQL 字面量，按方言处理引号与二进制。
fn sql_literal(v: &crate::domain::Value, dialect: crate::driver::Dialect) -> String {
    use crate::domain::Value as V;
    match v {
        V::Null => "NULL".to_string(),
        V::Bool(b) => match dialect {
            crate::driver::Dialect::Postgres => if *b { "TRUE" } else { "FALSE" }.to_string(),
            _ => if *b { "1" } else { "0" }.to_string(),
        },
        V::Int(_) | V::UInt(_) | V::Float(_) | V::Decimal(_) => v.to_text(),
        V::Bytes(b) => match dialect {
            crate::driver::Dialect::Postgres => format!("'\\x{}'::bytea", to_hex(b)),
            // Oracle 的十六进制字面量要显式转换
            crate::driver::Dialect::Oracle => format!("HEXTORAW('{}')", to_hex(b).to_uppercase()),
            _ => format!("X'{}'", to_hex(b)),
        },
        _ => {
            let s = v.to_text();
            match dialect {
                // 标准字符串字面量下反斜杠是普通字符，只转义单引号
                crate::driver::Dialect::Postgres => format!("'{}'", s.replace('\'', "''")),
                // Oracle 同理；DATE / TIMESTAMP 显式转型（会话 NLS 格式已固定）
                crate::driver::Dialect::Oracle => {
                    let lit = format!("'{}'", s.replace('\'', "''"));
                    match v {
                        V::Date(_) => format!("TO_DATE({lit}, 'YYYY-MM-DD HH24:MI:SS')"),
                        V::DateTime(_) => format!("TO_TIMESTAMP({lit}, 'YYYY-MM-DD HH24:MI:SS.FF')"),
                        _ => lit,
                    }
                }
                _ => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
            }
        }
    }
}

/// 整表导出（流式，不受结果集 1 万行上限约束），支持 CSV / JSON / SQL INSERT。
pub async fn export_table(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    table: &str,
    filters: &[FilterSpec],
    order_by: Option<&str>,
    order_dir: Option<&str>,
    format: ExportFormat,
    path: &str,
) -> AppResult<u64> {
    let conn = manager.get(id)?;
    let dialect = crate::driver::dialect_of(&conn);
    let types = if dialect == crate::driver::Dialect::Postgres {
        Some(
            crate::driver::list_columns(&conn, database, table)
                .await?
                .into_iter()
                .map(|c| (c.name, crate::driver::pg_cast_type(&c.raw_type)))
                .collect::<std::collections::HashMap<_, _>>(),
        )
    } else {
        None
    };

    let mut w = std::io::BufWriter::new(std::fs::File::create(path)?);
    // 只有 CSV 加 BOM，方便 Excel 直接打开不乱码
    if format == ExportFormat::Csv {
        w.write_all(&[0xEF, 0xBB, 0xBF])?;
    }
    let table_ref = format!(
        "{}.{}",
        dialect.quote(database),
        dialect.quote(table)
    );

    const PAGE: u64 = 1000;
    let mut offset = 0u64;
    let mut total = 0u64;
    let mut cols: Vec<String> = Vec::new();
    let mut started = false;
    let mut json_wrote_row = false;
    loop {
        let (sql, params) = build_preview_sql(
            dialect,
            types.as_ref(),
            database,
            table,
            filters,
            order_by,
            order_dir,
            PAGE,
            offset,
        );
        let rs = crate::driver::query_bound(&conn, Some(database), &sql, params, PAGE as usize).await?;
        if !started {
            cols = rs.columns.iter().map(|c| c.name.clone()).collect();
            match format {
                ExportFormat::Csv => {
                    let head: Vec<String> = cols.iter().map(|c| csv_field(c)).collect();
                    writeln!(w, "{}", head.join(","))?;
                }
                ExportFormat::Json => writeln!(w, "[")?,
                ExportFormat::Sql => {
                    writeln!(w, "-- 由 Myco Studio 从 {database}.{table} 导出")?;
                }
            }
            started = true;
        }
        for row in &rs.rows {
            match format {
                ExportFormat::Csv => {
                    let cells: Vec<String> = row.iter().map(|v| csv_field(&v.to_text())).collect();
                    writeln!(w, "{}", cells.join(","))?;
                }
                ExportFormat::Json => {
                    let obj: Vec<String> = cols
                        .iter()
                        .zip(row.iter())
                        .map(|(c, v)| {
                            format!(
                                "{}:{}",
                                serde_json::to_string(c).unwrap_or_else(|_| "\"\"".into()),
                                json_value(v)
                            )
                        })
                        .collect();
                    if json_wrote_row {
                        write!(w, ",\n  {{{}}}", obj.join(","))?;
                    } else {
                        write!(w, "  {{{}}}", obj.join(","))?;
                        json_wrote_row = true;
                    }
                }
                ExportFormat::Sql => {
                    let cl: Vec<String> = cols.iter().map(|c| dialect.quote(c)).collect();
                    let vl: Vec<String> = row.iter().map(|v| sql_literal(v, dialect)).collect();
                    writeln!(
                        w,
                        "INSERT INTO {} ({}) VALUES ({});",
                        table_ref,
                        cl.join(", "),
                        vl.join(", ")
                    )?;
                }
            }
        }
        total += rs.rows.len() as u64;
        if (rs.rows.len() as u64) < PAGE {
            break;
        }
        offset += PAGE;
    }
    if format == ExportFormat::Json {
        if json_wrote_row {
            writeln!(w, "\n]")?;
        } else {
            writeln!(w, "]")?;
        }
    }
    w.flush()?;
    Ok(total)
}

pub fn import_csv_preview(path: &str) -> AppResult<ImportPreview> {
    let bytes = std::fs::read(path)?;
    let text = decode_bytes(bytes);
    let delimiter = detect_delimiter(&text);
    let records = parse_csv(&text, delimiter);
    if records.is_empty() {
        return Err(AppError::Message("CSV 文件为空".to_string()));
    }
    let width = records.iter().map(|r| r.len()).max().unwrap_or(1);
    let has_header = records.len() > 1;
    let columns = if has_header {
        records[0].clone()
    } else {
        (0..width).map(|i| format!("列{}", i + 1)).collect()
    };
    let data_start = if has_header { 1 } else { 0 };
    let sample = records[data_start..].iter().take(5).cloned().collect();
    Ok(ImportPreview {
        delimiter: (delimiter as char).to_string(),
        has_header,
        columns,
        sample,
    })
}

pub async fn import_csv(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    table: &str,
    path: &str,
    delimiter: &str,
    has_header: bool,
    mapping: &[ImportColumn],
    skip_errors: bool,
) -> AppResult<ImportReport> {
    if mapping.is_empty() {
        return Err(AppError::Message("请至少映射一列".to_string()));
    }
    let bytes = std::fs::read(path)?;
    let text = decode_bytes(bytes);
    let delim = delimiter.chars().next().unwrap_or(',') as u8;
    let records = parse_csv(&text, delim);
    if records.is_empty() {
        return Err(AppError::Message("CSV 文件为空".to_string()));
    }
    let file_columns: Vec<String> = if has_header {
        records[0].clone()
    } else {
        (0..records[0].len()).map(|i| format!("列{}", i + 1)).collect()
    };
    let data_start = if has_header { 1 } else { 0 };

    let indexes: Vec<usize> = mapping
        .iter()
        .map(|m| {
            file_columns
                .iter()
                .position(|c| c == &m.file_column)
                .ok_or_else(|| AppError::Message(format!("CSV 里找不到列「{}」", m.file_column)))
        })
        .collect::<AppResult<_>>()?;

    let mut changes: Vec<Change> = Vec::with_capacity(records.len().saturating_sub(data_start));
    for row in &records[data_start..] {
        let values: Vec<ColumnValue> = mapping
            .iter()
            .enumerate()
            .map(|(mi, m)| {
                let raw = row.get(indexes[mi]).map(|s| s.as_str()).unwrap_or("");
                ColumnValue {
                    column: m.table_column.clone(),
                    value: if raw.is_empty() { None } else { Some(raw.to_string()) },
                }
            })
            .collect();
        changes.push(Change::Insert { values });
    }

    let conn = manager.get(id)?;
    if !skip_errors {
        let n = crate::driver::apply_changes(&conn, database, table, &changes).await?;
        return Ok(ImportReport { imported: n as u64, failed: 0, errors: vec![] });
    }

    let mut imported = 0u64;
    let mut failed = 0u64;
    let mut errors = Vec::new();
    for (i, change) in changes.iter().enumerate() {
        match crate::driver::apply_changes(&conn, database, table, std::slice::from_ref(change)).await {
            Ok(_) => imported += 1,
            Err(e) => {
                failed += 1;
                if errors.len() < 100 {
                    errors.push(format!("第 {} 行：{}", i + data_start + 1, e));
                }
            }
        }
    }
    Ok(ImportReport { imported, failed, errors })
}

pub async fn run_sql_file(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    path: &str,
) -> AppResult<SqlFileReport> {
    let text = std::fs::read_to_string(path)?;
    let statements = split_sql_statements(&text);
    let total = statements.len() as u64;
    let conn = manager.get(id)?;
    let mut executed = 0u64;
    for (i, stmt) in statements.iter().enumerate() {
        crate::driver::query(&conn, Some(database), stmt, MAX_ROWS)
            .await
            .map_err(|e| AppError::Message(format!("第 {} 条语句失败：{e}", i + 1)))?;
        executed += 1;
    }
    Ok(SqlFileReport { executed, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ConnectionConfig, DbFlavor};
    use crate::storage::{ConnectionStore, MemorySecretStore, SecretStore};
    use std::sync::Arc;

    /// Oracle 的字面量：字符串不认反斜杠转义，日期要显式转型，二进制用 HEXTORAW
    #[test]
    fn oracle_sql_literals() {
        use crate::domain::Value as V;
        use crate::driver::Dialect;
        assert_eq!(sql_literal(&V::Str("it's".into()), Dialect::Oracle), "'it''s'");
        assert_eq!(sql_literal(&V::Str(r"a\b".into()), Dialect::Oracle), r"'a\b'");
        assert_eq!(
            sql_literal(&V::Date("2024-01-02 03:04:05".into()), Dialect::Oracle),
            "TO_DATE('2024-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            sql_literal(&V::DateTime("2024-01-02 03:04:05.123".into()), Dialect::Oracle),
            "TO_TIMESTAMP('2024-01-02 03:04:05.123', 'YYYY-MM-DD HH24:MI:SS.FF')"
        );
        assert_eq!(
            sql_literal(&V::Bytes(vec![0xde, 0xad]), Dialect::Oracle),
            "HEXTORAW('DEAD')"
        );
        assert_eq!(sql_literal(&V::Null, Dialect::Oracle), "NULL");
        // 其它引擎保持原样
        assert_eq!(sql_literal(&V::Bytes(vec![0xde, 0xad]), Dialect::Mysql), "X'dead'");
    }

    fn pg_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "io-it".into(),
            name: "io-it".into(),
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

    /// 真正跑一遍导出与建 schema：需要真实 PostgreSQL，
    /// PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD 通过环境变量传入。
    #[tokio::test]
    #[ignore]
    async fn exports_all_formats_and_creates_schema() {
        let password = std::env::var("PGPASSWORD").expect("PGPASSWORD required");
        let cfg = pg_config();
        let dir = std::env::temp_dir().join(format!("myco-io-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store_path = dir.join("connections.json");
        std::fs::write(&store_path, serde_json::to_string(&vec![cfg.clone()]).unwrap()).unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        secrets.set(&cfg.id, &password).await.unwrap();
        let db = Arc::new(crate::storage::LocalDb::new(dir.join("local.sqlite")));
        let mgr = ConnectionManager::new(ConnectionStore::new(db, store_path), secrets);
        mgr.connect(&cfg.id).await.unwrap();
        let conn = mgr.get(&cfg.id).unwrap();
        let schema = "public";

        crate::driver::query(&conn, Some(schema), "DROP TABLE IF EXISTS t_io", 10).await.unwrap();
        crate::driver::query(
            &conn,
            Some(schema),
            "CREATE TABLE t_io (id int primary key, name text, flag boolean, \
             price numeric(10,2), data jsonb, blob bytea, \
             u uuid, ts timestamptz, arr int[], iv interval)",
            10,
        )
        .await
        .unwrap();
        crate::driver::query(
            &conn,
            Some(schema),
            "INSERT INTO t_io VALUES \
             (1, 'a,b', true, 12.34, '{\"k\":1}', '\\x00ff'::bytea, \
              '11111111-2222-3333-4444-555555555555', '2024-01-02 03:04:05+00', '{1,2,3}', '1 day'), \
             (2, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
            10,
        )
        .await
        .unwrap();

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();

        // CSV：BOM + 逗号转义
        let csv_path = out.join("t.csv");
        let n = export_table(&mgr, &cfg.id, schema, "t_io", &[], None, None, ExportFormat::Csv, csv_path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(n, 2);
        let csv = std::fs::read_to_string(&csv_path).unwrap();
        assert!(csv.starts_with('\u{feff}'), "CSV 需要带 BOM");
        assert!(csv.contains("\"a,b\""), "含逗号的值要加引号：{csv}");

        // JSON：必须是合法 JSON，且数字 / 布尔 / NULL 保持原生类型
        let json_path = out.join("t.json");
        export_table(&mgr, &cfg.id, schema, "t_io", &[], None, None, ExportFormat::Json, json_path.to_str().unwrap())
            .await
            .unwrap();
        let raw = std::fs::read_to_string(&json_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("导出的 JSON 必须合法");
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], serde_json::json!(1));
        assert_eq!(arr[0]["flag"], serde_json::json!(true));
        assert_eq!(arr[0]["price"], serde_json::json!(12.34));
        assert_eq!(arr[0]["u"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(arr[0]["arr"], "{1,2,3}");
        assert_eq!(arr[0]["iv"], "1 day");
        assert!(arr[0]["ts"].as_str().unwrap().starts_with("2024-01-02"));
        assert!(arr[0]["data"].as_str().unwrap().contains("\"k\""));
        assert!(arr[1]["name"].is_null());

        // 带筛选的导出：参数内联后仍然要正确过滤
        let filtered_path = out.join("filtered.json");
        let filters = vec![FilterSpec {
            column: "id".into(),
            operator: "=".into(),
            value: "1".into(),
        }];
        let n = export_table(
            &mgr,
            &cfg.id,
            schema,
            "t_io",
            &filters,
            None,
            None,
            ExportFormat::Json,
            filtered_path.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(n, 1);

        // 参数化计数（分页浏览走的就是这条路）
        let cnt = crate::driver::count_bound(
            &conn,
            Some(schema),
            "SELECT count(*) FROM t_io WHERE id > $1",
            vec!["0".into()],
        )
        .await
        .unwrap();
        assert_eq!(cnt, 2);

        // SQL INSERT：方言化的引号、布尔、二进制
        let sql_path = out.join("t.sql");
        export_table(&mgr, &cfg.id, schema, "t_io", &[], None, None, ExportFormat::Sql, sql_path.to_str().unwrap())
            .await
            .unwrap();
        let sql = std::fs::read_to_string(&sql_path).unwrap();
        assert!(sql.contains("INSERT INTO \"public\".\"t_io\""), "{sql}");
        assert!(sql.contains("TRUE"), "{sql}");
        assert!(sql.contains("NULL"), "{sql}");
        assert!(sql.contains(r"'\x00ff'::bytea"), "PG 二进制要转成 bytea 字面量：{sql}");

        // 建 schema，并确认能出现在「库」列表里（PG 的库 = schema）
        let new_schema = "myco_io_verify";
        crate::driver::query(&conn, None, &format!("DROP SCHEMA IF EXISTS {new_schema}"), 10).await.unwrap();
        crate::service::MutationService::create_database(&mgr, &cfg.id, new_schema, None, None)
            .await
            .unwrap();
        let dbs = crate::driver::list_databases(&conn).await.unwrap();
        assert!(dbs.iter().any(|d| d == new_schema), "新建的 schema 应该出现在库列表里：{dbs:?}");
        assert!(dbs.iter().any(|d| d == "public"));
        crate::driver::query(&conn, None, &format!("DROP SCHEMA {new_schema}"), 10).await.unwrap();

        crate::driver::query(&conn, Some(schema), "DROP TABLE t_io", 10).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
