use std::collections::HashMap;

use crate::domain::{Column, FilterSpec, ResultSet, Value};
use crate::driver::{self, Dialect, Page};
use crate::error::AppResult;
use crate::service::connection_manager::ConnectionManager;

/// 单次查询最多加载的行数（超出即截断），避免无 LIMIT 的大表查询拖垮内存。
pub const MAX_ROWS: usize = 10_000;

fn normalize_operator(op: &str) -> Option<&'static str> {
    match op.to_ascii_lowercase().as_str() {
        "=" => Some("="),
        "!=" => Some("!="),
        ">" => Some(">"),
        "<" => Some("<"),
        ">=" => Some(">="),
        "<=" => Some("<="),
        "like" => Some("LIKE"),
        _ => None,
    }
}

fn where_clause(
    dialect: Dialect,
    types: Option<&HashMap<String, String>>,
    filters: &[FilterSpec],
    params: &mut Vec<String>,
) -> String {
    let mut n = 0usize;
    let clauses: Vec<String> = filters
        .iter()
        .filter_map(|f| {
            let op = normalize_operator(&f.operator)?;
            params.push(if op == "LIKE" {
                format!("%{}%", f.value)
            } else {
                f.value.clone()
            });
            n += 1;
            // PG 对参数类型严格，给筛选值按列类型显式转型；
            // Oracle 用 `:1 :2` 位置绑定，其余引擎交给驱动
            let ph = match (dialect, types) {
                (Dialect::Postgres, Some(t)) => format!(
                    "${}::{}",
                    n,
                    driver::pg_cast_type(t.get(&f.column).map(String::as_str).unwrap_or("text"))
                ),
                _ => dialect.placeholder(n),
            };
            Some(format!("{} {} {}", dialect.quote(&f.column), op, ph))
        })
        .collect();
    if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    }
}

pub fn build_preview_sql(
    dialect: Dialect,
    types: Option<&HashMap<String, String>>,
    database: &str,
    table: &str,
    filters: &[FilterSpec],
    order_by: Option<&str>,
    order_dir: Option<&str>,
    limit: u64,
    offset: u64,
) -> (String, Vec<String>) {
    let mut params = Vec::new();
    let mut sql = format!(
        "SELECT * FROM {}.{}{}",
        dialect.quote(database),
        dialect.quote(table),
        where_clause(dialect, types, filters, &mut params)
    );
    if let Some(col) = order_by {
        if !col.is_empty() {
            let dir = if order_dir == Some("desc") { "DESC" } else { "ASC" };
            sql.push_str(&format!(" ORDER BY {} {}", dialect.quote(col), dir));
        }
    }
    sql.push_str(&dialect.limit_clause(limit, offset));
    (sql, params)
}

pub fn build_preview_count_sql(
    dialect: Dialect,
    types: Option<&HashMap<String, String>>,
    database: &str,
    table: &str,
    filters: &[FilterSpec],
) -> (String, Vec<String>) {
    let mut params = Vec::new();
    let sql = format!(
        "SELECT COUNT(*) FROM {}.{}{}",
        dialect.quote(database),
        dialect.quote(table),
        where_clause(dialect, types, filters, &mut params)
    );
    (sql, params)
}

pub struct QueryService;

impl QueryService {
    pub async fn run_sql(
        manager: &ConnectionManager,
        id: &str,
        database: Option<&str>,
        sql: &str,
    ) -> AppResult<ResultSet> {
        let conn = manager.get(id)?;
        driver::query(&conn, database, sql, MAX_ROWS).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn browse_table(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
        page: Page,
        page_size: u64,
        filters: Vec<FilterSpec>,
        order_by: Option<String>,
        order_dir: Option<String>,
    ) -> AppResult<BrowsedTable> {
        let conn = manager.get(id)?;
        let dialect = driver::dialect_of(&conn);
        let types = if dialect == Dialect::Postgres {
            Some(
                driver::list_columns(&conn, database, table)
                    .await?
                    .into_iter()
                    .map(|c| (c.name, driver::pg_cast_type(&c.raw_type)))
                    .collect::<HashMap<_, _>>(),
            )
        } else {
            None
        };
        let offset = page.offset * page_size;
        let (sql, params) = build_preview_sql(
            dialect,
            types.as_ref(),
            database,
            table,
            &filters,
            order_by.as_deref(),
            order_dir.as_deref(),
            page_size,
            offset,
        );
        let rs = driver::query_bound(&conn, Some(database), &sql, params, page_size as usize).await?;
        let (count_sql, count_params) =
            build_preview_count_sql(dialect, types.as_ref(), database, table, &filters);
        let total = driver::count_bound(&conn, Some(database), &count_sql, count_params).await?;
        Ok(BrowsedTable { columns: rs.columns, rows: rs.rows, total, elapsed_ms: rs.elapsed_ms })
    }
}

#[derive(Debug, serde::Serialize)]
pub struct BrowsedTable {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub total: i64,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_plain_select() {
        let (sql, params) = build_preview_sql(Dialect::Mysql, None, "mydb", "users", &[], None, None, 200, 0);
        assert_eq!(sql, "SELECT * FROM `mydb`.`users` LIMIT 200 OFFSET 0");
        assert!(params.is_empty());
    }

    #[test]
    fn builds_select_with_filters_and_sort() {
        let filters = vec![
            FilterSpec { column: "name".into(), operator: "like".into(), value: "ab".into() },
            FilterSpec { column: "id".into(), operator: ">".into(), value: "10".into() },
        ];
        let (sql, params) =
            build_preview_sql(Dialect::Mysql, None, "db", "t", &filters, Some("id"), Some("desc"), 100, 200);
        assert_eq!(
            sql,
            "SELECT * FROM `db`.`t` WHERE `name` LIKE ? AND `id` > ? ORDER BY `id` DESC LIMIT 100 OFFSET 200"
        );
        assert_eq!(params, vec!["%ab%".to_string(), "10".to_string()]);
    }

    #[test]
    fn drops_unknown_operators() {
        let filters = vec![FilterSpec { column: "id".into(), operator: "; drop".into(), value: "1".into() }];
        let (sql, params) = build_preview_sql(Dialect::Mysql, None, "db", "t", &filters, None, None, 10, 0);
        assert_eq!(sql, "SELECT * FROM `db`.`t` LIMIT 10 OFFSET 0");
        assert!(params.is_empty());
    }

    #[test]
    fn count_respects_filters() {
        let filters = vec![FilterSpec { column: "id".into(), operator: "=".into(), value: "5".into() }];
        let (sql, params) = build_preview_count_sql(Dialect::Mysql, None, "db", "t", &filters);
        assert_eq!(sql, "SELECT COUNT(*) FROM `db`.`t` WHERE `id` = ?");
        assert_eq!(params, vec!["5".to_string()]);
    }

    #[test]
    fn postgres_quotes_with_double_quotes() {
        let filters = vec![FilterSpec { column: "name".into(), operator: "like".into(), value: "ab".into() }];
        let types = HashMap::from([("name".to_string(), "varchar".to_string())]);
        let (sql, params) =
            build_preview_sql(Dialect::Postgres, Some(&types), "public", "t", &filters, None, None, 10, 0);
        assert_eq!(
            sql,
            "SELECT * FROM \"public\".\"t\" WHERE \"name\" LIKE $1::varchar LIMIT 10 OFFSET 0"
        );
        assert_eq!(params, vec!["%ab%".to_string()]);
    }

    #[test]
    fn oracle_uses_numbered_binds_and_fetch_first() {
        let filters = vec![
            FilterSpec { column: "name".into(), operator: "like".into(), value: "ab".into() },
            FilterSpec { column: "id".into(), operator: ">".into(), value: "10".into() },
        ];
        let (sql, params) = build_preview_sql(
            Dialect::Oracle,
            None,
            "APPUSER",
            "EMP",
            &filters,
            Some("id"),
            Some("asc"),
            100,
            200,
        );
        assert_eq!(
            sql,
            "SELECT * FROM \"APPUSER\".\"EMP\" WHERE \"name\" LIKE :1 AND \"id\" > :2 \
             ORDER BY \"id\" ASC OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY"
        );
        assert_eq!(params, vec!["%ab%".to_string(), "10".to_string()]);
    }

    /// 真库端到端（走 ConnectionManager + QueryService，和界面点按钮是同一条路）：
    /// `cargo test --lib -- --ignored --nocapture oracle_service_live`
    #[tokio::test]
    #[ignore = "需要真实 Oracle 实例"]
    async fn oracle_service_live() {
        use crate::domain::{ColumnValue, DbFlavor, FilterSpec as F};
        use crate::service::connection_manager::ConnectionManager;
        use crate::storage::{ConnectionStore, LocalDb, MemorySecretStore, SecretStore};
        use std::sync::Arc;

        let password = std::env::var("MYCO_ORA_PASSWORD").expect("需要设置 MYCO_ORA_PASSWORD 环境变量");
        let user = std::env::var("MYCO_ORA_USER").unwrap_or_else(|_| "appuser".into());
        let service = std::env::var("MYCO_ORA_SERVICE").unwrap_or_else(|_| "XEPDB1".into());
        let cfg = crate::domain::ConnectionConfig {
            id: "ora-live".into(),
            name: "ora-live".into(),
            host: std::env::var("MYCO_ORA_HOST").unwrap_or_else(|_| "10.25.77.160".into()),
            port: std::env::var("MYCO_ORA_PORT").unwrap_or_else(|_| "8165".into()).parse().unwrap(),
            username: user.clone(),
            database: Some(service),
            flavor: DbFlavor::Oracle,
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
        let dir = std::env::temp_dir().join(format!("myco-ora-svc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store_path = dir.join("connections.json");
        std::fs::write(&store_path, serde_json::to_string(&vec![cfg.clone()]).unwrap()).unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        secrets.set(&cfg.id, &password).await.unwrap();
        let mgr = ConnectionManager::new(
            ConnectionStore::new(Arc::new(LocalDb::new(dir.join("local.sqlite"))), store_path),
            secrets,
        );
        mgr.connect(&cfg.id).await.expect("连接失败");
        let schema = user.to_ascii_uppercase();

        // 建表并灌数据
        for sql in [
            format!("DROP TABLE {schema}.MYCO_SVC PURGE"),
            format!(
                "CREATE TABLE {schema}.MYCO_SVC (ID NUMBER(10) PRIMARY KEY, NAME VARCHAR2(50), AMT NUMBER(10,2))"
            ),
            format!(
                "INSERT INTO {schema}.MYCO_SVC (ID, NAME, AMT) SELECT LEVEL, 'n' || LEVEL, LEVEL * 1.5 \
                 FROM DUAL CONNECT BY LEVEL <= 120"
            ),
        ] {
            if let Err(e) = QueryService::run_sql(&mgr, &cfg.id, Some(&schema), &sql).await {
                assert!(sql.starts_with("DROP"), "{sql} → {e}");
            }
        }

        // 左侧对象树用的三件事
        let dbs = crate::service::IntrospectionService::list_databases(&mgr, &cfg.id).await.unwrap();
        assert!(dbs.contains(&schema), "{dbs:?}");
        let tables = crate::service::IntrospectionService::list_tables(&mgr, &cfg.id, &schema).await.unwrap();
        assert!(tables.iter().any(|t| t.name == "MYCO_SVC"));
        let cols = crate::service::IntrospectionService::list_columns(&mgr, &cfg.id, &schema, "MYCO_SVC")
            .await
            .unwrap();
        assert_eq!(cols.len(), 3);
        let overview = crate::service::IntrospectionService::database_schema(&mgr, &cfg.id, &schema)
            .await
            .unwrap();
        assert!(overview.iter().any(|t| t.name == "MYCO_SVC" && t.columns.len() == 3));

        // 表格浏览：第 2 页 + 筛选 + 排序
        let filters = vec![F { column: "ID".into(), operator: ">".into(), value: "20".into() }];
        let browsed = QueryService::browse_table(
            &mgr,
            &cfg.id,
            &schema,
            "MYCO_SVC",
            Page { limit: 50, offset: 1 },
            50,
            filters.clone(),
            Some("ID".into()),
            Some("asc".into()),
        )
        .await
        .expect("浏览失败");
        println!(
            "浏览：{} 行 / 共 {} / {}ms，首行 {:?}",
            browsed.rows.len(),
            browsed.total,
            browsed.elapsed_ms,
            browsed.rows.first()
        );
        assert_eq!(browsed.total, 100, "ID > 20 应有 100 行");
        assert_eq!(browsed.rows.len(), 50);
        assert_eq!(browsed.rows[0][0], crate::domain::Value::Int(71));

        // 结构页 / 编辑提交（走 dispatcher，和界面同一条路）
        let conn = mgr.get(&cfg.id).unwrap();
        let ddl = crate::driver::table_ddl(&conn, &schema, "MYCO_SVC").await.unwrap();
        assert!(ddl.contains("MYCO_SVC"));
        let comment = crate::driver::table_comment(&conn, &schema, "MYCO_SVC").await.unwrap();
        assert_eq!(comment, "");
        let applied = crate::driver::apply_changes(
            &conn,
            &schema,
            "MYCO_SVC",
            &[crate::domain::Change::Update {
                pk: vec![ColumnValue { column: "ID".into(), value: Some("1".into()) }],
                values: vec![ColumnValue { column: "NAME".into(), value: Some("改名".into()) }],
                original: vec![],
            }],
        )
        .await
        .expect("提交失败");
        assert_eq!(applied, 1);

        // AI 上下文：表清单 + DDL 要能拼出来
        let ctx = crate::service::ai_chat::build_context(&mgr, Some(&cfg.id), &schema, Some("MYCO_SVC"), "MYCO_SVC 怎么查")
            .await;
        println!("AI 上下文片段：{}", ctx.lines().take(6).collect::<Vec<_>>().join(" / "));
        assert!(ctx.contains("MYCO_SVC"), "{ctx}");
        assert!(ctx.to_uppercase().contains("CREATE TABLE"), "DDL 应该在上下文里");

        // 收尾
        QueryService::run_sql(&mgr, &cfg.id, Some(&schema), &format!("DROP TABLE {schema}.MYCO_SVC PURGE"))
            .await
            .expect("删表失败");
    }
}
