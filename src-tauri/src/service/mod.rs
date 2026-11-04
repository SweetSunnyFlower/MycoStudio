pub mod ai;
pub mod ai_chat;
pub mod connection_manager;
pub mod io;
pub mod pdm;
pub mod query;

pub use connection_manager::ConnectionManager;
pub use query::{BrowsedTable, QueryService};

use crate::driver::{ColumnInfo, TableInfo};
use crate::domain::{Change, TableSchema};
use crate::error::{AppError, AppResult};

pub struct IntrospectionService;

impl IntrospectionService {
    pub async fn list_databases(manager: &ConnectionManager, id: &str) -> AppResult<Vec<String>> {
        let conn = manager.get(id)?;
        crate::driver::list_databases(&conn).await
    }

    pub async fn list_tables(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
    ) -> AppResult<Vec<TableInfo>> {
        let conn = manager.get(id)?;
        crate::driver::list_tables(&conn, database).await
    }

    pub async fn list_columns(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        let conn = manager.get(id)?;
        crate::driver::list_columns(&conn, database, table).await
    }

    pub async fn database_schema(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
    ) -> AppResult<Vec<TableSchema>> {
        let conn = manager.get(id)?;
        crate::driver::schema_tables(&conn, database).await
    }

    /// ER 图用的整库结构快照
    pub async fn schema_graph(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
    ) -> AppResult<crate::domain::SchemaGraph> {
        let conn = manager.get(id)?;
        crate::driver::schema_graph(&conn, database).await
    }

    pub async fn table_ddl(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<String> {
        let conn = manager.get(id)?;
        crate::driver::table_ddl(&conn, database, table).await
    }

    pub async fn foreign_keys(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<crate::domain::ForeignKeyRef>> {
        let conn = manager.get(id)?;
        crate::driver::foreign_keys(&conn, database, table).await
    }

    pub async fn table_comment(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<String> {
        let conn = manager.get(id)?;
        crate::driver::table_comment(&conn, database, table).await
    }

    pub async fn indexes(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<crate::domain::IndexInfo>> {
        let conn = manager.get(id)?;
        crate::driver::indexes(&conn, database, table).await
    }
}

pub struct MutationService;

impl MutationService {
    /// 新建数据库（MySQL 系）或 schema（PostgreSQL）。SQLite 无此概念。
    pub async fn create_database(
        manager: &ConnectionManager,
        id: &str,
        name: &str,
        charset: Option<&str>,
        collation: Option<&str>,
    ) -> AppResult<()> {
        let conn = manager.get(id)?;
        let dialect = crate::driver::dialect_of(&conn);
        let ident = dialect.quote(name);
        let sql = match dialect {
            crate::driver::Dialect::Postgres => format!("CREATE SCHEMA {ident}"),
            crate::driver::Dialect::Sqlite => {
                return Err(AppError::Message(
                    "SQLite 是单文件数据库，不支持新建数据库 / schema".to_string(),
                ))
            }
            crate::driver::Dialect::Oracle => {
                return Err(AppError::Message(
                    "Oracle 里 schema 就是用户，请让 DBA 执行 CREATE USER 创建".to_string(),
                ))
            }
            crate::driver::Dialect::Mysql => {
                let mut s = format!("CREATE DATABASE {ident}");
                if let Some(c) = charset.map(str::trim).filter(|c| !c.is_empty()) {
                    s.push_str(&format!(" DEFAULT CHARACTER SET {c}"));
                }
                if let Some(c) = collation.map(str::trim).filter(|c| !c.is_empty()) {
                    s.push_str(&format!(" COLLATE {c}"));
                }
                s
            }
        };
        crate::driver::query(&conn, None, &sql, 1).await?;
        Ok(())
    }

    pub async fn apply_changes(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
        changes: &[Change],
    ) -> AppResult<usize> {
        let conn = manager.get(id)?;
        crate::driver::apply_changes(&conn, database, table, changes).await
    }
}
