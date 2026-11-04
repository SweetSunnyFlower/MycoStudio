# 数据库客户端（database-desktop）设计文档

- 日期：2026-10-10
- 状态：已评审通过（待写实现计划）

## 1. 概述

开发一个跨平台桌面数据库客户端，Rust 实现核心逻辑，Tauri 作为桌面壳，Web 前端负责界面。首期只支持 MySQL，后续扩展到其他关系型与非关系型数据库。

## 2. 目标与非目标

### 2.1 目标（MVP = 阶段 A）

1. 连接管理：新增 / 编辑 / 删除 / 测试多个 MySQL 连接，连接配置持久化，密码安全存储。
2. 结构浏览：按“库 → 表 → 字段”浏览数据库 schema。
3. SQL 查询：SQL 编辑器（语法高亮），执行任意 SQL，分页展示结果表格。
4. 只读定位：MVP 不做数据写回，聚焦打通全链路。

### 2.2 非目标（MVP 不做，写入 roadmap）

- 结果表格内编辑数据（阶段 B）。
- CSV 导出、SQL 自动补全、多结果标签、SSL/SSH 隧道、深色模式、保存常用查询（阶段 C）。
- 非关系型数据库（Redis / MongoDB）实现（接口预留，MVP 不实现）。

## 3. 技术选型

### 3.1 运行时与语言

- Rust（edition 2024），当前工具链 1.99.0。
- 异步运行时：tokio（与 Tauri / sqlx 一致）。

### 3.2 桌面壳与前端

- Tauri 2.x：跨平台桌面壳，Rust 后端 + 系统 WebView。
- 前端：React + TypeScript + Vite。
- UI：Tailwind CSS + shadcn/ui。
- SQL 编辑器：Monaco（`@monaco-editor/react`）。
- 结果表格：TanStack Table。
- 前端状态：Zustand（轻量，避免过度设计）。

### 3.3 Rust 核心依赖

- `sqlx`：关系型统一驱动（MySQL 协议族 / PostgreSQL / SQLite），异步 + 元数据 + 流式。
- `keyring`：密码跨平台安全存储（macOS Keychain / Windows 凭据管理器 / Linux Secret Service）。
- `serde` / `serde_json`：序列化与 IPC DTO。
- `thiserror`：错误类型。
- `dirs`：平台配置目录定位。
- `tracing`：日志。
- 非关系型（后续）：`redis`、`mongodb` 官方 crate。

## 4. 总体架构

一个 Tauri 应用，两个进程：

- **Rust 后端**：所有数据库逻辑、连接管理、`keyring` 密码存储、连接配置持久化。只通过 Tauri command（IPC）对外暴露能力。
- **Web 前端**：纯 UI，不含数据库逻辑，通过 `invoke()` 调用后端 command。

Rust 侧分为四个模块层（MVP 单 crate，按模块分层）：

1. `domain`：共享类型（`Value` / `Column` / `Row` / `ResultSet` / `ConnectionConfig` 等）。
2. `driver`：`RelationalDriver` / `NonRelationalDriver` 两个 trait 及实现。
3. `service`：`ConnectionManager`（连接生命周期）、`QueryService`（执行查询 / 分页）、`IntrospectionService`（库 / 表 / 字段内省）。
4. `storage`：`ConnectionStore`（非敏感连接配置存本地 JSON）、`SecretStore`（`keyring` 存密码）。

## 5. 领域模型

- `Value`：serde 可序列化的 enum，覆盖常见 SQL 类型：Null / Int / UInt / BigInt / Float / Double / Decimal / String / Bytes / Date / Time / DateTime / Json 等。
- `Column { name: String, type_name: String }`。
- `Row = Vec<Value>`。
- `ResultSet { columns: Vec<Column>, rows: Vec<Row>, truncated: bool }`。
- `ConnectionConfig`：主机、端口、用户名、数据库、`flavor`（`mysql` / `mariadb` / `tidb`，同走 MySQL 协议）；**不含密码**。
- `ConnectionId`：连接的唯一标识（UUID）。

## 6. 驱动抽象

### 6.1 关系型 trait

```rust
enum DbConnection {
    Mysql(sqlx::MySqlConnection), // MVP 仅此一种
    // 未来: Postgres(sqlx::PgConnection), Sqlite(sqlx::SqliteConnection)
    // 未来: Redis(...), Mongo(...)
}

#[async_trait]
trait RelationalDriver: Send + Sync {
    async fn connect(config: &ConnectionConfig) -> Result<DbConnection, DriverError>;
    async fn list_databases(conn: &mut DbConnection) -> Result<Vec<String>>;
    async fn list_tables(conn: &mut DbConnection, db: &str) -> Result<Vec<TableInfo>>;
    async fn list_columns(conn: &mut DbConnection, db: &str, table: &str) -> Result<Vec<ColumnInfo>>;
    async fn query(conn: &mut DbConnection, sql: &str, page: Page) -> Result<ResultSet>;
}
```

### 6.2 协议族划分

关系型按“协议”归组，而非每个数据库一个驱动：

- MySQL 协议族：MySQL / MariaDB / TiDB → 均走 `sqlx` MySQL 驱动，仅以 `flavor` 区分。
- PostgreSQL → `sqlx` Postgres 驱动。
- SQLite → `sqlx` SQLite 驱动。

### 6.3 非关系型 trait

`NonRelationalDriver` 仅预留接口（Redis 键/命令、MongoDB 集合/文档），MVP 不实现，避免与关系型模型强耦合。

## 7. 前端结构与 IPC

界面四块：

1. 连接列表 + 连接新增/编辑弹窗。
2. 左侧 schema 树（库 → 表 → 字段）。
3. SQL 编辑器（Monaco）。
4. 结果表格（TanStack Table，分页）。

后端 command（Tauri IPC）：

- `list_connections` / `save_connection` / `delete_connection`
- `test_connection`
- `connect` / `disconnect`
- `list_databases` / `list_tables` / `list_columns`
- `run_query`

## 8. 数据流与分页

- **浏览表数据**：生成 `SELECT * FROM <table> LIMIT ? OFFSET ?`，另用 `COUNT(*)` 计算总数，做真分页。
- **任意 SQL**：直接执行并流式读取，设上限（默认 1000 行），超出标记 `truncated`，前端提示“仅显示前 N 行”，避免大结果拖死内存。

## 9. 错误处理、并发与安全

- 错误统一为 `DriverError`（`thiserror`），Tauri command 返回 `Result<Dto, AppError>`；前端 toast 展示；密码永不回传 / 打印 / 落盘明文。
- 并发：每个已保存连接维护一个 `sqlx` 连接池，`HashMap<ConnectionId, MySqlPool>` 由 Tauri `State` 托管，异步并发，单用户场景足够。
- 安全：
  - 非敏感连接配置存 `<平台配置目录>/database-desktop/connections.json`（`dirs` 定位）。
  - 密码走 `keyring`：service 名 `database-desktop`，account 用 `ConnectionId`。

## 10. 测试策略

- Rust 单元测试：领域类型、分页逻辑、`ConnectionStore`（临时目录）。
- Rust 集成测试：驱动对真实 MySQL（Docker / CI），`#[ignore]` 默认跳过，CI 启用。
- 前端：MVP 靠 Rust 测试 + 手动验收，组件测试后续补充。

## 11. Roadmap

- **阶段 B**：结果表格内增删改 + 事务控制。
- **阶段 C**：CSV 导出、SQL 自动补全、多结果标签、SSL/SSH 隧道、深色模式、保存常用查询。
- 后续关系型：PostgreSQL、SQLite。
- 后续非关系型：Redis、MongoDB（接口已预留）。

## 12. 关键决策记录

1. 采用 Tauri + React/TS + shadcn/ui，核心逻辑留在 Rust。
2. 驱动分两族：关系型（`sqlx` 统一）、非关系型（官方驱动），接口分开。
3. 关系型按协议族实现，MySQL/MariaDB/TiDB 共用 MySQL 驱动。
4. 密码用 `keyring` 存系统安全凭据库，连接配置存本地 JSON。
5. MVP 只做只读浏览（阶段 A），B/C 进 roadmap。
