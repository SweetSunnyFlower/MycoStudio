# 数据库客户端 MVP（阶段 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Tauri 桌面数据库客户端，首期支持 MySQL 的只读浏览（连接管理 + 结构浏览 + SQL 查询/分页结果），并为后续多数据库扩展预留抽象。

**Architecture:** 单 Tauri 应用、双进程：Rust 后端负责数据库逻辑/连接/密码存储，React 前端只做 UI，通过 Tauri command（IPC）通信。Rust 侧分 `domain` / `driver` / `service` / `storage` 四层，驱动按关系型（`sqlx`）与非关系型（官方 crate）两族抽象，MVP 仅实现 MySQL。

**Tech Stack:** Tauri 2.x、Rust edition 2024、sqlx 0.9（MySQL）、keyring 3.x、tokio、React + TypeScript + Vite、Tailwind CSS + shadcn/ui、Monaco、TanStack Table、Zustand。

**Spec:** [docs/superpowers/specs/2026-10-10-database-client-design.md](../specs/2026-10-10-database-client-design.md)

## Global Constraints

- Rust edition 2024；工具链 1.99.0（已安装）。
- Tauri 使用稳定版 `2`，不要使用 3.0-alpha；前端 `@tauri-apps/api` 与 `@tauri-apps/cli` 均为 `^2`。
- `sqlx = { version = "0.9", features = ["runtime-tokio-rustls", "mysql", "chrono"] }`；后续再加 `postgres`、`sqlite`。
- `keyring = "3"`，使用 `Entry::new(service, user) -> Result<Entry>` / `set_password` / `get_password` / `delete_credential` API。
- 其他 Rust 依赖版本：`tokio = "1"`、`thiserror = "2"`、`serde = "1"`、`serde_json = "1"`、`uuid = { version = "1", features = ["v4", "serde"] }`、`dirs = "7"`、`tracing = "0.1"`、`async-trait = "0.1"`、`chrono = { version = "0.4", default-features = false, features = ["std"] }`、`futures = "0.3"`。
- 包名 `database-desktop`，Rust lib 名 `database_desktop`，Tauri command 用 snake_case。
- 连接配置存 `<dirs::config_dir()>/database-desktop/connections.json`；keyring service 名 `database-desktop`，account 用 `ConnectionId`。
- 任意 SQL 结果上限 `MAX_ROWS = 1000`；表浏览默认分页大小 `DEFAULT_PAGE_SIZE = 200`。
- 前端依赖：`react`/`react-dom` ^19、`@monaco-editor/react`、`@tanstack/react-table` ^8、`zustand`、`tailwindcss`（由 shadcn 初始化）、`lucide-react`（shadcn 图标）。
- 所有 Rust 新功能遵循 TDD：先写失败测试，再实现，再跑测试通过，再 commit。

---

### Task 1: 脚手架 Tauri 2 + React/TS 项目并验证可编译

**Files:**
- Create: 整个项目脚手架（`package.json`、`vite.config.ts`、`src/`、`src-tauri/` 等，由 create-tauri-app 生成）
- Test: 无（本任务为脚手架验证，用构建命令验证）

**Interfaces:**
- Consumes: 无
- Produces: 一个可 `cargo check`（src-tauri）与 `npm run build`（前端）通过的空 Tauri 应用骨架，含默认图标。

- [ ] **Step 1: 用官方脚手架在临时目录生成项目**

Run（在项目父目录 `/Users/gao/baidu/personal-code`）:

```bash
npm create tauri-app@latest database-desktop-scaffold -- --template react-ts --manager npm --identifier com.databasedesktop.app --yes
```

Expected: 生成 `database-desktop-scaffold/`。若非交互参数被拒，改为运行 `npm create tauri-app@latest database-desktop-scaffold` 并手动选择：框架 React、语言 TypeScript、包管理器 npm、标识符 `com.databasedesktop.app`。

- [ ] **Step 2: 合并进仓库并清理**

```bash
rm -rf database-desktop-scaffold/.git
cp -R database-desktop-scaffold/. /Users/gao/baidu/personal-code/database-desktop/
rm -rf database-desktop-scaffold
cd /Users/gao/baidu/personal-code/database-desktop
npm install
```

- [ ] **Step 3: 验证前端与 Rust 都能编译**

Run:

```bash
npm run build
cd src-tauri && cargo check
```

Expected: `npm run build` 成功产出 `dist/`；`cargo check` 成功（无错误）。

- [ ] **Step 4: 确认 .gitignore 覆盖生成物**

Run: `cat .gitignore`
Expected: 包含 `node_modules`、`dist`、`src-tauri/target`。若缺，补上：

```gitignore
node_modules
dist
src-tauri/target
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold tauri + react-ts project"
```

---

### Task 2: 接入 Tailwind + shadcn/ui 与前端依赖

**Files:**
- Modify: `package.json`、`src/`（由 shadcn 初始化生成 `src/index.css`、`components.json` 等）
- Create: `src/lib/utils.ts`（shadcn 生成）、`src/components/ui/*`（shadcn 生成的 button/input/dialog 等）
- Test: 无（用 `npm run build` 验证）

**Interfaces:**
- Consumes: Task 1 的脚手架
- Produces: 可用的 shadcn/ui 组件 + Monaco/TanStack Table/Zustand 依赖；`src/lib/utils.ts` 导出 `cn()`。

- [ ] **Step 1: 初始化 shadcn**

Run:

```bash
npx shadcn@latest init -y
```

Expected: 检测到 Vite，配置 Tailwind（v4），生成 `components.json`、`src/index.css`、`src/lib/utils.ts`，并在 `src/App.tsx` 或 CSS 中接入主题变量。若 `-y` 无法跳过交互，交互选择：base color = Neutral，CSS variables = yes。

- [ ] **Step 2: 添加所需 shadcn 组件**

Run:

```bash
npx shadcn@latest add -y button input label textarea dialog select tabs table scroll-area
```

Expected: `src/components/ui/` 下生成对应组件。

- [ ] **Step 3: 安装前端依赖**

Run:

```bash
npm install @monaco-editor/react @tanstack/react-table zustand
```

- [ ] **Step 4: 冒烟验证（渲染一个 shadcn Button）**

Modify `src/App.tsx`：

```tsx
import { Button } from "@/components/ui/button";

export default function App() {
  return (
    <main className="p-4">
      <Button>数据库客户端</Button>
    </main>
  );
}
```

Run: `npm run build`
Expected: 编译成功。若 `@` 路径别名未配置，shadcn 初始化会自动配置到 `tsconfig.json` 与 `vite.config.ts`；若报错，确认 `vite.config.ts` 含 `resolve.alias` 指向 `./src`。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: add tailwind, shadcn/ui and frontend deps"
```

---

### Task 3: Rust 领域类型与错误类型（TDD）

**Files:**
- Create: `src-tauri/src/domain.rs`
- Create: `src-tauri/src/error.rs`
- Test: `src-tauri/src/domain.rs`（内联 `#[cfg(test)]`）

**Interfaces:**
- Consumes: 无
- Produces: `domain::{Value, Column, ResultSet, DbFlavor, ConnectionConfig}`；`error::{AppError, AppResult}`。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/domain.rs` 中写（类型尚未定义，编译失败即 red）：

```rust
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
    fn connection_config_never_holds_password_field() {
        let cfg = ConnectionConfig {
            id: "c1".into(),
            name: "local".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            username: "root".into(),
            database: None,
            flavor: DbFlavor::Mysql,
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(!s.contains("password"));
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test domain::tests -- --nocapture`
Expected: 编译失败（`domain` 模块与类型未定义）。

- [ ] **Step 3: 实现 domain.rs**

```rust
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbFlavor {
    Mysql,
    MariaDb,
    TiDb,
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
    fn connection_config_never_holds_password_field() {
        let cfg = ConnectionConfig {
            id: "c1".into(),
            name: "local".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            username: "root".into(),
            database: None,
            flavor: DbFlavor::Mysql,
        };
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(!s.contains("password"));
    }
}
```

- [ ] **Step 4: 实现 error.rs**

```rust
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),
    #[error("{0}")]
    Message(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd src-tauri && cargo test domain::tests`
Expected: 3 个测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add domain types and error type"
```

---

### Task 4: 存储层 —— 连接配置与密钥存储（TDD）

**Files:**
- Create: `src-tauri/src/storage/mod.rs`
- Create: `src-tauri/src/storage/connection_store.rs`
- Create: `src-tauri/src/storage/secret_store.rs`
- Test: 内联 `#[cfg(test)]`

**Interfaces:**
- Consumes: `domain::ConnectionConfig`、`error::{AppError, AppResult}`
- Produces:
  - `ConnectionStore { path: PathBuf }`：`load_all()` / `save(&ConnectionConfig)` / `delete(&str)`
  - `trait SecretStore: Send + Sync { set/get/delete }`、`KeyringSecretStore`、`MemorySecretStore`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/storage/connection_store.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ConnectionConfig, DbFlavor};
    use std::fs;

    fn cfg(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: format!("conn-{id}"),
            host: "127.0.0.1".into(),
            port: 3306,
            username: "root".into(),
            database: None,
            flavor: DbFlavor::Mysql,
        }
    }

    #[test]
    fn saves_loads_and_deletes() {
        let dir = std::env::temp_dir().join(format!("cdtest-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = ConnectionStore::new(dir.join("connections.json"));
        store.save(&cfg("a")).unwrap();
        store.save(&cfg("b")).unwrap();
        assert_eq!(store.load_all().unwrap().len(), 2);
        store.delete("a").unwrap();
        assert_eq!(store.load_all().unwrap().len(), 1);
    }

    #[test]
    fn loads_empty_when_missing() {
        let dir = std::env::temp_dir().join(format!("cdtest-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = ConnectionStore::new(dir.join("nope.json"));
        assert!(store.load_all().unwrap().is_empty());
    }
}
```

`src-tauri/src/storage/secret_store.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrips_and_deletes() {
        let s = MemorySecretStore::default();
        assert_eq!(s.get("k").unwrap(), None);
        s.set("k", "v").unwrap();
        assert_eq!(s.get("k").unwrap(), Some("v".to_string()));
        s.delete("k").unwrap();
        assert_eq!(s.get("k").unwrap(), None);
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test storage::`
Expected: 编译失败。

- [ ] **Step 3: 实现 connection_store.rs**

```rust
use std::fs;
use std::path::PathBuf;

use crate::domain::ConnectionConfig;
use crate::error::AppResult;

pub struct ConnectionStore {
    path: PathBuf,
}

impl ConnectionStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load_all(&self) -> AppResult<Vec<ConnectionConfig>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.path)?;
        let configs = serde_json::from_str(&raw)?;
        Ok(configs)
    }

    pub fn save(&self, config: &ConnectionConfig) -> AppResult<()> {
        let mut all = self.load_all()?;
        all.retain(|c| c.id != config.id);
        all.push(config.clone());
        self.write_all(&all)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut all = self.load_all()?;
        all.retain(|c| c.id != id);
        self.write_all(&all)
    }

    fn write_all(&self, all: &[ConnectionConfig]) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(all)?;
        fs::write(&self.path, raw)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ConnectionConfig, DbFlavor};
    use std::fs;

    fn cfg(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: format!("conn-{id}"),
            host: "127.0.0.1".into(),
            port: 3306,
            username: "root".into(),
            database: None,
            flavor: DbFlavor::Mysql,
        }
    }

    #[test]
    fn saves_loads_and_deletes() {
        let dir = std::env::temp_dir().join(format!("cdtest-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = ConnectionStore::new(dir.join("connections.json"));
        store.save(&cfg("a")).unwrap();
        store.save(&cfg("b")).unwrap();
        assert_eq!(store.load_all().unwrap().len(), 2);
        store.delete("a").unwrap();
        assert_eq!(store.load_all().unwrap().len(), 1);
    }

    #[test]
    fn loads_empty_when_missing() {
        let dir = std::env::temp_dir().join(format!("cdtest-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = ConnectionStore::new(dir.join("nope.json"));
        assert!(store.load_all().unwrap().is_empty());
    }
}
```

- [ ] **Step 4: 实现 secret_store.rs**

```rust
use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "database-desktop";

pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> AppResult<()>;
    fn get(&self, key: &str) -> AppResult<Option<String>>;
    fn delete(&self, key: &str) -> AppResult<()>;
}

pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn set(&self, key: &str, value: &str) -> AppResult<()> {
        let entry = keyring::Entry::new(SERVICE, key)?;
        entry.set_password(value)?;
        Ok(())
    }

    fn get(&self, key: &str) -> AppResult<Option<String>> {
        let entry = keyring::Entry::new(SERVICE, key)?;
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keyring(e)),
        }
    }

    fn delete(&self, key: &str) -> AppResult<()> {
        let entry = keyring::Entry::new(SERVICE, key)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(e)),
        }
    }
}

#[derive(Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn set(&self, key: &str, value: &str) -> AppResult<()> {
        self.map.lock().unwrap().insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn get(&self, key: &str) -> AppResult<Option<String>> {
        Ok(self.map.lock().unwrap().get(key).cloned())
    }

    fn delete(&self, key: &str) -> AppResult<()> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrips_and_deletes() {
        let s = MemorySecretStore::default();
        assert_eq!(s.get("k").unwrap(), None);
        s.set("k", "v").unwrap();
        assert_eq!(s.get("k").unwrap(), Some("v".to_string()));
        s.delete("k").unwrap();
        assert_eq!(s.get("k").unwrap(), None);
    }
}
```

- [ ] **Step 5: 实现 storage/mod.rs**

```rust
pub mod connection_store;
pub mod secret_store;

pub use connection_store::ConnectionStore;
pub use secret_store::{KeyringSecretStore, MemorySecretStore, SecretStore};
```

- [ ] **Step 6: 注册模块**

Modify `src-tauri/src/lib.rs`：在模块声明区加入 `pub mod domain; pub mod error; pub mod storage;`。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd src-tauri && cargo test storage::`
Expected: 全部 PASS。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add connection and secret stores"
```

---

### Task 5: 驱动抽象 trait 与连接枚举

**Files:**
- Create: `src-tauri/src/driver/mod.rs`
- Create: `src-tauri/src/driver/mysql.rs`（占位，Task 6 补全）
- Test: 无独立测试（靠 Task 6 编译覆盖）

**Interfaces:**
- Consumes: `domain::{ConnectionConfig, ResultSet}`、`error::AppResult`
- Produces: `DbConnection { Mysql(sqlx::MySqlPool) }`、`Page { limit, offset }`、`TableInfo`、`ColumnInfo`、`trait RelationalDriver`、`trait NonRelationalDriver`。

- [ ] **Step 1: 实现 driver/mod.rs**

```rust
use async_trait::async_trait;

use crate::domain::{ConnectionConfig, ResultSet};
use crate::error::AppResult;

pub mod mysql;

pub enum DbConnection {
    Mysql(sqlx::MySqlPool),
}

impl DbConnection {
    pub fn as_mysql(&self) -> &sqlx::MySqlPool {
        match self {
            DbConnection::Mysql(p) => p,
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
}

#[async_trait]
pub trait RelationalDriver: Send + Sync {
    async fn connect(config: &ConnectionConfig, password: &str) -> AppResult<DbConnection>;
    async fn list_databases(conn: &DbConnection) -> AppResult<Vec<String>>;
    async fn list_tables(conn: &DbConnection, database: &str) -> AppResult<Vec<TableInfo>>;
    async fn list_columns(conn: &DbConnection, database: &str, table: &str)
        -> AppResult<Vec<ColumnInfo>>;
    async fn query(conn: &DbConnection, sql: &str, max_rows: usize) -> AppResult<ResultSet>;
    async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64>;
}

pub trait NonRelationalDriver: Send + Sync {}
```

- [ ] **Step 2: 占位 mysql.rs 以便编译**

Create `src-tauri/src/driver/mysql.rs`：

```rust
//! MySQL 驱动实现（Task 6 中补全）。
```

Run: `cd src-tauri && cargo check`
Expected: 编译通过（trait 定义本身无需实现即可编译）。

- [ ] **Step 3: 注册模块并 Commit**

Modify `src-tauri/src/lib.rs` 追加 `pub mod driver;`。

```bash
git add -A
git commit -m "feat: add driver traits and connection enum"
```

---

### Task 6: MySQL 驱动实现（sqlx）+ 集成测试

**Files:**
- Modify: `src-tauri/src/driver/mysql.rs`
- Test: `src-tauri/src/driver/mysql.rs`（内联 `#[cfg(test)]`，`#[ignore]` 集成测试）

**Interfaces:**
- Consumes: Task 5 的 `RelationalDriver`、`DbConnection`、`domain` 类型
- Produces: `MysqlDriver`（实现 `RelationalDriver`）、`value_from_row` 辅助函数。

- [ ] **Step 1: 写集成测试（标 ignore）**

Append 到 `src-tauri/src/driver/mysql.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ConnectionConfig, DbFlavor};

    fn test_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "it".into(),
            name: "integration".into(),
            host: std::env::var("DB_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: std::env::var("DB_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3306),
            username: std::env::var("DB_USER").unwrap_or_else(|_| "root".into()),
            database: None,
            flavor: DbFlavor::Mysql,
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 MySQL，用 DB_PASSWORD 环境变量
    async fn connects_lists_and_queries() {
        let cfg = test_config();
        let pw = std::env::var("DB_PASSWORD").expect("DB_PASSWORD required");
        let conn = MysqlDriver::connect(&cfg, &pw).await.unwrap();

        let dbs = MysqlDriver::list_databases(&conn).await.unwrap();
        assert!(dbs.iter().any(|d| d == "information_schema"));

        let tables = MysqlDriver::list_tables(&conn, "information_schema").await.unwrap();
        assert!(tables.iter().any(|t| t.name == "TABLES"));

        let cols = MysqlDriver::list_columns(&conn, "information_schema", "TABLES").await.unwrap();
        assert!(cols.iter().any(|c| c.name == "TABLE_NAME"));

        let rs = MysqlDriver::query(&conn, "SELECT 1 AS one, 'x' AS s, NULL AS n", 1000).await.unwrap();
        assert_eq!(rs.columns.len(), 3);
        assert_eq!(rs.rows.len(), 1);
        assert!(!rs.truncated);

        let total = MysqlDriver::count(&conn, "SELECT COUNT(*) FROM information_schema.TABLES").await.unwrap();
        assert!(total > 0);
    }
}
```

- [ ] **Step 2: 实现 mysql.rs 核心**

```rust
use async_trait::async_trait;
use futures::StreamExt;

use super::{ColumnInfo, DbConnection, RelationalDriver, TableInfo};
use crate::domain::{Column, ConnectionConfig, ResultSet, Value};
use crate::error::AppResult;

pub struct MysqlDriver;

fn connect_options(config: &ConnectionConfig, password: &str) -> sqlx::mysql::MySqlConnectOptions {
    let mut opts = sqlx::mysql::MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .username(&config.username)
        .password(password);
    if let Some(db) = &config.database {
        opts = opts.database(db);
    }
    opts
}

fn value_from_row(row: &sqlx::mysql::MySqlRow, i: usize) -> sqlx::Result<Value> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let ty = raw.type_info().name().to_ascii_lowercase();
    Ok(match ty.as_str() {
        "tiny" | "year" => Value::Int(row.try_get::<i8, _>(i)? as i64),
        "short" => Value::Int(row.try_get::<i16, _>(i)? as i64),
        "long" => Value::Int(row.try_get::<i32, _>(i)? as i64),
        "longlong" => Value::Int(row.try_get::<i64, _>(i)?),
        "float" => Value::Float(row.try_get::<f32, _>(i)? as f64),
        "double" => Value::Float(row.try_get::<f64, _>(i)?),
        "decimal" | "newdecimal" => Value::Decimal(row.try_get::<String, _>(i)?),
        "date" => Value::Date(row.try_get::<chrono::NaiveDate, _>(i)?.to_string()),
        "time" => Value::Time(row.try_get::<chrono::NaiveTime, _>(i)?.to_string()),
        "datetime" | "timestamp" => {
            Value::DateTime(row.try_get::<chrono::NaiveDateTime, _>(i)?.to_string())
        }
        "json" => Value::Json(row.try_get::<String, _>(i)?),
        "blob" | "tiny_blob" | "medium_blob" | "long_blob" => {
            Value::Bytes(row.try_get::<Vec<u8>, _>(i)?)
        }
        _ => Value::Str(row.try_get::<String, _>(i)?),
    })
}

fn columns_of(row: &sqlx::mysql::MySqlRow) -> Vec<Column> {
    row.columns()
        .iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

#[async_trait]
impl RelationalDriver for MysqlDriver {
    async fn connect(config: &ConnectionConfig, password: &str) -> AppResult<DbConnection> {
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(4)
            .connect_with(connect_options(config, password))
            .await?;
        Ok(DbConnection::Mysql(pool))
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
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE \
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
            });
        }
        Ok(out)
    }

    async fn query(conn: &DbConnection, sql: &str, max_rows: usize) -> AppResult<ResultSet> {
        let pool = conn.as_mysql();
        let mut stream = sqlx::query(sql).fetch(pool);

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

        let columns = rows.first().map(columns_of).unwrap_or_default();
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut values = Vec::with_capacity(row.len());
            for i in 0..row.len() {
                values.push(value_from_row(row, i)?);
            }
            out_rows.push(values);
        }

        Ok(ResultSet { columns, rows: out_rows, truncated })
    }

    async fn count(conn: &DbConnection, sql: &str) -> AppResult<i64> {
        let (n,): (i64,) = sqlx::query_as(sql).fetch_one(conn.as_mysql()).await?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ConnectionConfig, DbFlavor};

    fn test_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "it".into(),
            name: "integration".into(),
            host: std::env::var("DB_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: std::env::var("DB_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3306),
            username: std::env::var("DB_USER").unwrap_or_else(|_| "root".into()),
            database: None,
            flavor: DbFlavor::Mysql,
        }
    }

    #[tokio::test]
    #[ignore] // 需要真实 MySQL，用 DB_PASSWORD 环境变量
    async fn connects_lists_and_queries() {
        let cfg = test_config();
        let pw = std::env::var("DB_PASSWORD").expect("DB_PASSWORD required");
        let conn = MysqlDriver::connect(&cfg, &pw).await.unwrap();

        let dbs = MysqlDriver::list_databases(&conn).await.unwrap();
        assert!(dbs.iter().any(|d| d == "information_schema"));

        let tables = MysqlDriver::list_tables(&conn, "information_schema").await.unwrap();
        assert!(tables.iter().any(|t| t.name == "TABLES"));

        let cols = MysqlDriver::list_columns(&conn, "information_schema", "TABLES").await.unwrap();
        assert!(cols.iter().any(|c| c.name == "TABLE_NAME"));

        let rs = MysqlDriver::query(&conn, "SELECT 1 AS one, 'x' AS s, NULL AS n", 1000).await.unwrap();
        assert_eq!(rs.columns.len(), 3);
        assert_eq!(rs.rows.len(), 1);
        assert!(!rs.truncated);

        let total = MysqlDriver::count(&conn, "SELECT COUNT(*) FROM information_schema.TABLES").await.unwrap();
        assert!(total > 0);
    }
}
```

- [ ] **Step 3: 确认编译**

Run: `cd src-tauri && cargo check`
Expected: 编译通过。

- [ ] **Step 4: 用真实 MySQL 跑集成测试（可选）**

Run: `cd src-tauri && DB_PASSWORD=<密码> cargo test mysql::tests -- --ignored --nocapture`
Expected: PASS。若某列解码类型不匹配，按真实 `type_info().name()` 修正 `value_from_row` 分支后重跑。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement mysql driver via sqlx"
```

---

### Task 7: 服务层 —— 连接管理、内省与查询（TDD）

**Files:**
- Create: `src-tauri/src/service/mod.rs`
- Create: `src-tauri/src/service/connection_manager.rs`
- Create: `src-tauri/src/service/query.rs`
- Test: `src-tauri/src/service/query.rs`（内联，纯函数部分）

**Interfaces:**
- Consumes: `ConnectionStore`、`Arc<dyn SecretStore>`、`MysqlDriver`、`domain`、`Page`
- Produces: `ConnectionManager::new/store/config/connect/disconnect/get`；`IntrospectionService::list_databases/list_tables/list_columns`；`QueryService::run_sql/browse_table`；`BrowsedTable { columns, rows, total }`。

- [ ] **Step 1: 写失败测试（纯函数 SQL 拼接）**

`src-tauri/src/service/query.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_sql_quotes_identifiers() {
        assert_eq!(
            table_select_sql("mydb", "users", 200, 0),
            "SELECT * FROM `mydb`.`users` LIMIT 200 OFFSET 0"
        );
        assert_eq!(
            table_count_sql("mydb", "users"),
            "SELECT COUNT(*) FROM `mydb`.`users`"
        );
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test service::`
Expected: 编译失败。

- [ ] **Step 3: 实现 query.rs**

```rust
use crate::domain::{Column, ResultSet, Value};
use crate::driver::mysql::MysqlDriver;
use crate::driver::{Page, RelationalDriver};
use crate::error::AppResult;
use crate::service::connection_manager::ConnectionManager;

pub const MAX_ROWS: usize = 1000;

pub fn table_select_sql(database: &str, table: &str, limit: u64, offset: u64) -> String {
    format!("SELECT * FROM `{database}`.`{table}` LIMIT {limit} OFFSET {offset}")
}

pub fn table_count_sql(database: &str, table: &str) -> String {
    format!("SELECT COUNT(*) FROM `{database}`.`{table}`")
}

pub struct QueryService;

impl QueryService {
    pub async fn run_sql(manager: &ConnectionManager, id: &str, sql: &str) -> AppResult<ResultSet> {
        let pool = manager.get(id)?;
        MysqlDriver::query(&pool, sql, MAX_ROWS).await
    }

    pub async fn browse_table(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
        page: Page,
        page_size: u64,
    ) -> AppResult<BrowsedTable> {
        let pool = manager.get(id)?;
        let offset = page.offset * page_size;
        let rs = MysqlDriver::query(
            &pool,
            &table_select_sql(database, table, page_size, offset),
            page_size as usize,
        )
        .await?;
        let total = MysqlDriver::count(&pool, &table_count_sql(database, table)).await?;
        Ok(BrowsedTable { columns: rs.columns, rows: rs.rows, total })
    }
}

#[derive(Debug, serde::Serialize)]
pub struct BrowsedTable {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub total: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_sql_quotes_identifiers() {
        assert_eq!(
            table_select_sql("mydb", "users", 200, 0),
            "SELECT * FROM `mydb`.`users` LIMIT 200 OFFSET 0"
        );
        assert_eq!(
            table_count_sql("mydb", "users"),
            "SELECT COUNT(*) FROM `mydb`.`users`"
        );
    }
}
```

- [ ] **Step 4: 实现 connection_manager.rs**

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sqlx::mysql::MySqlPool;

use crate::domain::ConnectionConfig;
use crate::driver::mysql::MysqlDriver;
use crate::driver::{DbConnection, RelationalDriver};
use crate::error::{AppError, AppResult};
use crate::storage::{ConnectionStore, SecretStore};

pub struct ConnectionManager {
    store: ConnectionStore,
    secrets: Arc<dyn SecretStore>,
    pools: Mutex<HashMap<String, MySqlPool>>,
}

impl ConnectionManager {
    pub fn new(store: ConnectionStore, secrets: Arc<dyn SecretStore>) -> Self {
        Self { store, secrets, pools: Mutex::new(HashMap::new()) }
    }

    pub fn store(&self) -> &ConnectionStore {
        &self.store
    }

    pub fn config(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.store
            .load_all()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }

    pub async fn connect(&self, id: &str) -> AppResult<()> {
        let config = self.config(id)?;
        let password = self
            .secrets
            .get(id)?
            .ok_or_else(|| AppError::Message("密码未保存".to_string()))?;
        let pool = MysqlDriver::connect(&config, &password).await?;
        if let DbConnection::Mysql(p) = pool {
            self.pools.lock().unwrap().insert(id.to_string(), p);
        }
        Ok(())
    }

    pub fn disconnect(&self, id: &str) {
        self.pools.lock().unwrap().remove(id);
    }

    pub fn get(&self, id: &str) -> AppResult<MySqlPool> {
        self.pools
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }
}
```

- [ ] **Step 5: 实现 service/mod.rs**

```rust
pub mod connection_manager;
pub mod query;

pub use connection_manager::ConnectionManager;
pub use query::{BrowsedTable, QueryService};

use crate::driver::{ColumnInfo, RelationalDriver, TableInfo};
use crate::error::AppResult;

pub struct IntrospectionService;

impl IntrospectionService {
    pub async fn list_databases(manager: &ConnectionManager, id: &str) -> AppResult<Vec<String>> {
        let pool = manager.get(id)?;
        crate::driver::mysql::MysqlDriver::list_databases(&pool).await
    }

    pub async fn list_tables(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
    ) -> AppResult<Vec<TableInfo>> {
        let pool = manager.get(id)?;
        crate::driver::mysql::MysqlDriver::list_tables(&pool, database).await
    }

    pub async fn list_columns(
        manager: &ConnectionManager,
        id: &str,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        let pool = manager.get(id)?;
        crate::driver::mysql::MysqlDriver::list_columns(&pool, database, table).await
    }
}
```

- [ ] **Step 6: 注册模块**

Modify `src-tauri/src/lib.rs` 追加 `pub mod service;`。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd src-tauri && cargo test service:: && cargo check`
Expected: `table_sql_quotes_identifiers` PASS，编译通过。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add connection manager and query service"
```

---

### Task 8: Tauri 命令层与状态装配

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `ConnectionStore`、`KeyringSecretStore`、`ConnectionManager`、`QueryService`、`IntrospectionService`
- Produces: 11 个前端可调用的 command；`AppState` 托管于 Tauri State。

- [ ] **Step 1: 实现 commands.rs**

```rust
use std::sync::Arc;

use tauri::State;

use crate::domain::{ConnectionConfig, ResultSet};
use crate::driver::{ColumnInfo, Page, RelationalDriver, TableInfo};
use crate::error::AppResult;
use crate::service::{BrowsedTable, ConnectionManager, IntrospectionService, QueryService};
use crate::storage::{ConnectionStore, KeyringSecretStore, SecretStore};

pub struct AppState {
    pub manager: ConnectionManager,
    pub secrets: Arc<dyn SecretStore>,
}

pub fn build_state(store: ConnectionStore) -> AppState {
    let secrets: Arc<dyn SecretStore> = Arc::new(KeyringSecretStore);
    AppState { manager: ConnectionManager::new(store, secrets.clone()), secrets }
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    state.manager.store().load_all()
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<ConnectionConfig> {
    state.manager.store().save(&config)?;
    if let Some(pw) = password {
        state.secrets.set(&config.id, &pw)?;
    }
    Ok(config)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.disconnect(&id);
    state.manager.store().delete(&id)?;
    state.secrets.delete(&id)?;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig, password: String) -> AppResult<()> {
    let conn = crate::driver::mysql::MysqlDriver::connect(&config, &password).await?;
    conn.as_mysql().close().await;
    Ok(())
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.manager.connect(&id).await
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>, id: String) {
    state.manager.disconnect(&id);
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    IntrospectionService::list_databases(&state.manager, &id).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> AppResult<Vec<TableInfo>> {
    IntrospectionService::list_tables(&state.manager, &id, &database).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    IntrospectionService::list_columns(&state.manager, &id, &database, &table).await
}

#[tauri::command]
pub async fn run_sql(state: State<'_, AppState>, id: String, sql: String) -> AppResult<ResultSet> {
    QueryService::run_sql(&state.manager, &id, &sql).await
}

#[tauri::command]
pub async fn browse_table(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
    page: u64,
    page_size: u64,
) -> AppResult<BrowsedTable> {
    QueryService::browse_table(
        &state.manager,
        &id,
        &database,
        &table,
        Page { limit: page_size, offset: page },
        page_size,
    )
    .await
}
```

- [ ] **Step 2: 在 lib.rs 装配 Builder**

Modify `src-tauri/src/lib.rs`：保留 create-tauri-app 生成的插件与 `run()` 结构，把 `invoke_handler` 与 `setup` 替换为：

```rust
mod commands;
pub mod domain;
pub mod driver;
pub mod error;
pub mod service;
pub mod storage;

use crate::storage::ConnectionStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_tables,
            commands::list_columns,
            commands::run_sql,
            commands::browse_table,
        ])
        .setup(|app| {
            let dir = dirs::config_dir()
                .unwrap_or_else(|| std::env::temp_dir())
                .join("database-desktop");
            let store = ConnectionStore::new(dir.join("connections.json"));
            app.manage(commands::build_state(store));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

注意：若模板 `lib.rs` 已有 `.plugin(...)`（如 `tauri_plugin_opener`），保留这些插件调用，只改 invoke_handler 与 setup。

- [ ] **Step 3: 更新 Cargo.toml 依赖**

Modify `src-tauri/Cargo.toml` 的 `[dependencies]`，加入（避免与模板已有项重复）：

```toml
sqlx = { version = "0.9", features = ["runtime-tokio-rustls", "mysql", "chrono"] }
keyring = "3"
tokio = { version = "1", features = ["full"] }
thiserror = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
dirs = "7"
tracing = "0.1"
async-trait = "0.1"
chrono = { version = "0.4", default-features = false, features = ["std"] }
futures = "0.3"
```

- [ ] **Step 4: 运行 cargo check**

Run: `cd src-tauri && cargo check`
Expected: 编译通过。若 `keyring::Error::NoEntry` 变体不存在，把 `get`/`delete` 里的 `NoEntry` 分支改为通配 `_ => Ok(None)` / `_ => Ok(())`。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire tauri commands and app state"
```

---

### Task 9: 前端类型、API 客户端与状态

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/api.ts`
- Create: `src/store/app.ts`

**Interfaces:**
- Consumes: Task 8 的 command 签名
- Produces: TS 类型与 `api.*`、`useAppStore`。

- [ ] **Step 1: 写 types.ts**

```ts
export type DbFlavor = "mysql" | "mariadb" | "tidb";

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  database: string | null;
  flavor: DbFlavor;
}

export type Value =
  | { type: "null" }
  | { type: "bool"; value: boolean }
  | { type: "int"; value: number }
  | { type: "uint"; value: number }
  | { type: "float"; value: number }
  | { type: "decimal"; value: string }
  | { type: "str"; value: string }
  | { type: "bytes"; value: number[] }
  | { type: "date"; value: string }
  | { type: "time"; value: string }
  | { type: "datetime"; value: string }
  | { type: "json"; value: string };

export interface Column { name: string; type_name: string; }
export interface ResultSet { columns: Column[]; rows: Value[][]; truncated: boolean; }
export interface ColumnInfo { name: string; data_type: string; nullable: boolean; }
export interface TableInfo { name: string; }
export interface BrowsedTable { columns: Column[]; rows: Value[][]; total: number; }

export function valueToDisplay(v: Value): string {
  if (v.type === "null") return "NULL";
  if (v.type === "bytes") return `<binary ${v.value.length}B>`;
  return String((v as { value: unknown }).value);
}
```

- [ ] **Step 2: 写 api.ts**

```ts
import { invoke } from "@tauri-apps/api/core";
import type { BrowsedTable, ColumnInfo, ConnectionConfig, ResultSet, TableInfo } from "./types";

export const api = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, password?: string) =>
    invoke<ConnectionConfig>("save_connection", { config, password: password ?? null }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (config: ConnectionConfig, password: string) =>
    invoke<void>("test_connection", { config, password }),
  connect: (id: string) => invoke<void>("connect", { id }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  listDatabases: (id: string) => invoke<string[]>("list_databases", { id }),
  listTables: (id: string, database: string) => invoke<TableInfo[]>("list_tables", { id, database }),
  listColumns: (id: string, database: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { id, database, table }),
  runSql: (id: string, sql: string) => invoke<ResultSet>("run_sql", { id, sql }),
  browseTable: (id: string, database: string, table: string, page: number, pageSize: number) =>
    invoke<BrowsedTable>("browse_table", { id, database, table, page, pageSize }),
};
```

- [ ] **Step 3: 写 store/app.ts**

```ts
import { create } from "zustand";
import type { BrowsedTable, ConnectionConfig, ResultSet } from "@/lib/types";

export interface BrowseKey { db: string; table: string; }

interface AppState {
  connections: ConnectionConfig[];
  activeId: string | null;
  databases: string[];
  browseKey: BrowseKey | null;
  result: ResultSet | BrowsedTable | null;
  loading: boolean;
  error: string | null;
  setConnections: (c: ConnectionConfig[]) => void;
  setActiveId: (id: string | null) => void;
  setDatabases: (d: string[]) => void;
  setBrowseKey: (k: BrowseKey | null) => void;
  setResult: (r: ResultSet | BrowsedTable | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  connections: [],
  activeId: null,
  databases: [],
  browseKey: null,
  result: null,
  loading: false,
  error: null,
  setConnections: (connections) => set({ connections }),
  setActiveId: (activeId) => set({ activeId }),
  setDatabases: (databases) => set({ databases }),
  setBrowseKey: (browseKey) => set({ browseKey }),
  setResult: (result) => set({ result }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
```

- [ ] **Step 4: 验证编译**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add frontend types, api client and store"
```

---

### Task 10: 前端连接列表与连接表单

**Files:**
- Create: `src/components/ConnectionList.tsx`
- Create: `src/components/ConnectionForm.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `api`、`useAppStore`
- Produces: 连接列表（加载/选择/连接/删除）+ 新增/编辑弹窗（含密码输入）。

- [ ] **Step 1: 实现 ConnectionForm.tsx**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { ConnectionConfig, DbFlavor } from "@/lib/types";

interface Props {
  open: boolean;
  initial: ConnectionConfig | null;
  onClose: () => void;
  onSaved: (c: ConnectionConfig) => void;
}

export function ConnectionForm({ open, initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(initial?.port ?? 3306));
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [flavor, setFlavor] = useState<DbFlavor>(initial?.flavor ?? "mysql");
  const [password, setPassword] = useState("");

  async function save() {
    const config: ConnectionConfig = {
      id: initial?.id ?? crypto.randomUUID(),
      name, host, port: Number(port), username,
      database: database || null, flavor,
    };
    onSaved(await api.saveConnection(config, password || undefined));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{initial ? "编辑连接" : "新建连接"}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid gap-1"><Label>类型</Label>
            <Select value={flavor} onValueChange={(v) => setFlavor(v as DbFlavor)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mysql">MySQL</SelectItem>
                <SelectItem value="mariadb">MariaDB</SelectItem>
                <SelectItem value="tidb">TiDB</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <div className="grid gap-1"><Label>主机</Label><Input value={host} onChange={(e) => setHost(e.target.value)} /></div>
            <div className="grid gap-1"><Label>端口</Label><Input value={port} onChange={(e) => setPort(e.target.value)} /></div>
          </div>
          <div className="grid gap-1"><Label>用户名</Label><Input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
          <div className="grid gap-1"><Label>密码</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={initial ? "留空则不改" : ""} /></div>
          <div className="grid gap-1"><Label>默认库（可选）</Label><Input value={database} onChange={(e) => setDatabase(e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={() => void save()}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 实现 ConnectionList.tsx**

```tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { ConnectionConfig } from "@/lib/types";
import { ConnectionForm } from "./ConnectionForm";

export function ConnectionList() {
  const { connections, activeId, setConnections, setActiveId, setDatabases, setResult, setError } = useAppStore();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);

  async function refresh() {
    setConnections(await api.listConnections());
  }

  useEffect(() => { void refresh(); }, []);

  async function connect(c: ConnectionConfig) {
    try {
      setError(null);
      await api.connect(c.id);
      setActiveId(c.id);
      setDatabases(await api.listDatabases(c.id));
      setResult(null);
    } catch (e) { setError(String(e)); }
  }

  async function remove(id: string) {
    await api.deleteConnection(id);
    if (activeId === id) setActiveId(null);
    await refresh();
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">连接</span>
        <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>新建</Button>
      </div>
      {connections.map((c) => (
        <div key={c.id} className={`flex items-center justify-between rounded px-2 py-1 ${activeId === c.id ? "bg-muted" : ""}`}>
          <button className="text-left text-sm" onClick={() => void connect(c)}>{c.name}</button>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(c); setFormOpen(true); }}>编辑</Button>
            <Button size="sm" variant="ghost" onClick={() => void remove(c.id)}>删除</Button>
          </div>
        </div>
      ))}
      <ConnectionForm open={formOpen} initial={editing} onClose={() => setFormOpen(false)}
        onSaved={async () => { setFormOpen(false); await refresh(); }} />
    </div>
  );
}
```

- [ ] **Step 3: 接入 App.tsx 布局骨架**

```tsx
import { ConnectionList } from "@/components/ConnectionList";

export default function App() {
  return (
    <div className="flex h-screen">
      <aside className="w-56 border-r"><ConnectionList /></aside>
      <main className="flex-1">结构树与查询区（后续任务）</main>
    </div>
  );
}
```

- [ ] **Step 4: 验证编译**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add connection list and form"
```

---

### Task 11: 前端 schema 树

**Files:**
- Create: `src/components/SchemaTree.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `api`、`useAppStore`
- Produces: “库 → 表 → 字段”树；双击/点击“浏览数据”调用 `browse_table` 并写结果与 `browseKey`。

- [ ] **Step 1: 实现 SchemaTree.tsx**

```tsx
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { ColumnInfo, TableInfo } from "@/lib/types";

export function SchemaTree() {
  const { activeId, databases, setResult, setBrowseKey, setError } = useAppStore();
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [columns, setColumns] = useState<Record<string, ColumnInfo[]>>({});
  const [openDb, setOpenDb] = useState<string | null>(null);
  const [openTable, setOpenTable] = useState<string | null>(null);

  useEffect(() => { setTables({}); setColumns({}); setOpenDb(null); setOpenTable(null); }, [activeId]);

  if (!activeId) return <div className="p-2 text-sm text-muted-foreground">请先连接</div>;

  async function toggleDb(db: string) {
    setOpenDb(openDb === db ? null : db);
    if (!tables[db]) setTables((t) => ({ ...t, [db]: await api.listTables(activeId!, db) }));
  }

  async function toggleTable(db: string, table: string) {
    const key = `${db}.${table}`;
    setOpenTable(openTable === key ? null : key);
    if (!columns[key]) setColumns((c) => ({ ...c, [key]: await api.listColumns(activeId!, db, table) }));
  }

  async function browse(db: string, table: string) {
    try {
      setError(null);
      setBrowseKey({ db, table });
      setResult(await api.browseTable(activeId!, db, table, 0, 200));
    } catch (e) { setError(String(e)); }
  }

  return (
    <div className="flex flex-col gap-1 p-2 text-sm">
      {databases.map((db) => (
        <div key={db}>
          <button className="w-full text-left font-medium" onClick={() => void toggleDb(db)}>
            {openDb === db ? "▾" : "▸"} {db}
          </button>
          {openDb === db && (tables[db] ?? []).map((t) => (
            <div key={t.name} className="pl-3">
              <button className="w-full text-left" onClick={() => void toggleTable(db, t.name)}>
                {openTable === `${db}.${t.name}` ? "▾" : "▸"} {t.name}
              </button>
              {openTable === `${db}.${t.name}` && (columns[`${db}.${t.name}`] ?? []).map((c) => (
                <div key={c.name} className="pl-3 text-xs text-muted-foreground">{c.name}</div>
              ))}
              <button className="pl-3 text-xs text-blue-600" onClick={() => void browse(db, t.name)}>浏览数据</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 接入 App.tsx**

Modify `src/App.tsx`：引入 `SchemaTree`，在 `<main>` 左侧加入 `<aside className="w-72 border-r"><SchemaTree /></aside>`。

- [ ] **Step 3: 验证编译**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add schema tree browser"
```

---

### Task 12: 前端 SQL 编辑器与执行

**Files:**
- Create: `src/components/SqlEditor.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `api.runSql`、`useAppStore`
- Produces: Monaco SQL 编辑器 + “运行”按钮。

- [ ] **Step 1: 实现 SqlEditor.tsx**

```tsx
import { useState } from "react";
import Editor from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";

export function SqlEditor() {
  const { activeId, setResult, setBrowseKey, setError, setLoading } = useAppStore();
  const [sql, setSql] = useState("SELECT 1 AS ok;");

  async function run() {
    if (!activeId) { setError("请先连接"); return; }
    setLoading(true);
    try {
      setError(null);
      setBrowseKey(null);
      setResult(await api.runSql(activeId, sql));
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 p-2">
        <Button onClick={() => void run()}>运行</Button>
      </div>
      <div className="min-h-0 flex-1">
        <Editor height="100%" language="sql" value={sql} onChange={(v) => setSql(v ?? "")}
          theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 13 }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 接入 App.tsx 主区**

Modify `src/App.tsx`：主区纵向排布——上方 `SqlEditor`（约 40% 高）、下方结果区（Task 13）。

- [ ] **Step 3: 验证编译**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add sql editor and run action"
```

---

### Task 13: 前端结果表格与分页

**Files:**
- Create: `src/components/ResultsGrid.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useAppStore.result`、`useAppStore.browseKey`、`api.browseTable`
- Produces: TanStack Table 只读表格；`BrowsedTable` 显示总数并分页。

- [ ] **Step 1: 实现 ResultsGrid.tsx**

```tsx
import { useMemo, useState } from "react";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import { valueToDisplay } from "@/lib/types";

const PAGE_SIZE = 200;

export function ResultsGrid() {
  const { result, activeId, browseKey, setResult, setError } = useAppStore();
  const [page, setPage] = useState(0);
  const total = result && "total" in result ? result.total : null;

  const columns = useMemo(
    () => (result ? result.columns.map((c) => ({
      accessorKey: c.name,
      header: `${c.name} (${c.type_name})`,
    })) : []),
    [result],
  );

  const data = useMemo(
    () => (result
      ? result.rows.map((r) => {
          const o: Record<string, string> = {};
          r.forEach((v, j) => {
            const key = columns[j]?.accessorKey ?? String(j);
            o[key] = valueToDisplay(v);
          });
          return o;
        })
      : []),
    [result, columns],
  );

  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });

  if (!result) return <div className="p-2 text-sm text-muted-foreground">暂无结果</div>;

  async function changePage(next: number) {
    if (!activeId || !browseKey) return;
    setPage(next);
    try {
      setResult(await api.browseTable(activeId, browseKey.db, browseKey.table, next, PAGE_SIZE));
    } catch (e) { setError(String(e)); }
  }

  return (
    <div className="flex h-full flex-col">
      {result.truncated && <div className="p-2 text-xs text-amber-600">仅显示前 N 行</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => <TableHead key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</TableHead>)}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {total !== null && (
        <div className="flex items-center gap-2 p-2 text-sm">
          <span>共 {total} 行</span>
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => void changePage(page - 1)}>上一页</Button>
          <Button size="sm" variant="outline" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => void changePage(page + 1)}>下一页</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 接入 App.tsx 结果区**

Modify `src/App.tsx`：在主区下方加入 `<ResultsGrid />`，用 `flex` 让编辑器与结果区按比例分配高度。

- [ ] **Step 3: 验证编译**

Run: `npm run build`
Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add results grid with pagination"
```

---

### Task 14: 端到端联调、错误提示与 README

**Files:**
- Modify: `src/App.tsx`（错误/加载展示、布局收尾）
- Create: `README.md`
- Modify: `src-tauri/tauri.conf.json`（标题/窗口尺寸）

**Interfaces:**
- Consumes: 全部前端组件与后端 command
- Produces: 可运行 MVP（`npm run tauri dev`）。

- [ ] **Step 1: App.tsx 加入错误与加载展示**

```tsx
import { useAppStore } from "@/store/app";
import { ConnectionList } from "@/components/ConnectionList";
import { SchemaTree } from "@/components/SchemaTree";
import { SqlEditor } from "@/components/SqlEditor";
import { ResultsGrid } from "@/components/ResultsGrid";

export default function App() {
  const { error, loading } = useAppStore();
  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 border-r"><ConnectionList /></aside>
        <aside className="w-72 shrink-0 border-r"><SchemaTree /></aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="h-2/5 min-h-0"><SqlEditor /></div>
          <div className="min-h-0 flex-1 border-t"><ResultsGrid /></div>
        </main>
      </div>
      {loading && <div className="p-2 text-sm text-muted-foreground">执行中…</div>}
      {error && <div className="p-2 text-sm text-red-600">错误：{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: 更新 tauri.conf.json**

`app.windows[0].title` 设为 `"数据库客户端"`，`width`/`height` 设为 `1200`/`760`。

- [ ] **Step 3: 写 README.md**

内容：项目简介、技术栈、开发命令（`npm install`、`npm run tauri dev`、`cd src-tauri && cargo test`）、集成测试环境变量（`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`）、目录结构、Roadmap（阶段 B/C 与 PostgreSQL/SQLite/Redis/MongoDB）。

- [ ] **Step 4: 全量验证**

Run:

```bash
npm run build
cd src-tauri && cargo test && cargo check
cd .. && npm run tauri build
```

Expected: 前端构建、Rust 测试与 `cargo check` 全部通过；`tauri build` 成功产出安装包（首次较慢）。

- [ ] **Step 5: 手动验收清单（`npm run tauri dev`）**

- 新建 MySQL 连接（含密码）→ 列表出现该连接
- 点击连接 → 成功并显示“库”列表
- 展开库 → 显示表；展开表 → 显示字段
- 点击“浏览数据”→ 结果表格显示，翻页正常
- SQL 编辑器运行 `SELECT ...` → 结果表格显示；超 1000 行出现截断提示
- 断开/删除连接后列表与状态正确

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: end-to-end integration and readme"
```

---

## Self-Review

- **Spec 覆盖**：连接管理（Task 10 + 4）、结构浏览（Task 6 + 11）、SQL 查询/分页（Task 6/7 + 12/13）、两族驱动抽象（Task 5）、keyring 密码（Task 4）、只读 MVP（无写操作）均有用任务覆盖。
- **占位符**：无 TBD/TODO。
- **类型一致**：`Page { limit, offset }`、`Value` 的 serde 形状（`{type,value}`）在前端 `types.ts` 与后端 `domain.rs` 一致；command 参数名（`config`/`password`/`id`/`database`/`table`/`page`/`page_size`）与前端 `invoke` 一致。
