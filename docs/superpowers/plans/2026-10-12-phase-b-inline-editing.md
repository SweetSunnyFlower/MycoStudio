# 阶段 B：结果表格内增删改 + 事务控制 · 实现计划

**Goal:** 在表数据视图中支持暂存式增删改，并在「提交」时用一个数据库事务统一落库（失败整体回滚）。

**Architecture:** 后端新增 `Change` 领域类型与 `apply_changes` 命令（按引擎在事务里执行参数化 DML）；列元数据增加 `primary_key`；前端 `ResultsGrid` 增加可编辑模式，`TablePanel` 负责暂存状态与提交/回滚。

**Tech Stack:** 与阶段 A 相同（Tauri 2 / Rust / sqlx / React+TS / shadcn/ui / TanStack 已改用普通 Table）。

**Spec:** [docs/superpowers/specs/2026-10-12-phase-b-inline-editing-design.md](../specs/2026-10-12-phase-b-inline-editing-design.md)

## Global Constraints

- 沿用阶段 A 的约束：Rust edition 2024；sqlx 0.9（`runtime-tokio` + `tls-rustls` + `mysql` + `sqlite` + `chrono`）；标识符一律反引号包裹并转义；值一律参数化绑定。
- 新增后端命令 `apply_changes(id, database, table, changes)`；`changes` 是 `Change[]`，其 serde 形状为 `{"kind":"insert"|"update"|"delete", ...}`。
- UPDATE/DELETE 必须带主键；无主键表前端只读（后端对 Update/Delete 的空 `pk` 直接跳过，不报错）。
- `Option<String>` 中 `None` = NULL，`Some("")` = 空串，两者区分。
- 事务：任一语句失败即整体回滚并返回原始错误，不允许部分落库。
- 前端行编辑走「暂存」：改动先写进本地 state，提交成功后再重新拉数据；提交失败保留暂存。

---

### Task 1: 列元数据增加 `primary_key`

**Files:**
- Modify: `src-tauri/src/domain.rs`、`src-tauri/src/driver/mysql.rs`、`src-tauri/src/driver/sqlite.rs`
- Modify: `src/lib/types.ts`

**Interfaces:**
- Consumes: `ColumnInfo`（现有 `{ name, data_type, nullable }`）
- Produces: `ColumnInfo { name, data_type, nullable, primary_key: bool }`

- [ ] **Step 1: 改 domain.rs**

在 `ColumnInfo` 加字段：

```rust
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}
```

- [ ] **Step 2: MySQL list_columns 取主键**

`src-tauri/src/driver/mysql.rs` 的 `list_columns` 查询改为：

```sql
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
```

构造时：

```rust
out.push(ColumnInfo {
    name: row.try_get::<String, _>(0)?,
    data_type: row.try_get::<String, _>(1)?,
    nullable: row.try_get::<String, _>(2)?.eq_ignore_ascii_case("YES"),
    primary_key: row.try_get::<String, _>(3)?.eq_ignore_ascii_case("PRI"),
});
```

- [ ] **Step 3: SQLite list_columns 取主键**

`pragma_table_info` 第 6 列是 `pk`（0/正整数），改动 `src-tauri/src/driver/sqlite.rs`：

```rust
let rows = sqlx::query("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?)")
    .bind(table)
    .fetch_all(conn.as_sqlite())
    .await?;
...
let notnull: i64 = row.try_get(2)?;
let pk: i64 = row.try_get(3)?;
out.push(ColumnInfo {
    name: row.try_get::<String, _>(0)?,
    data_type: row.try_get::<String, _>(1)?,
    nullable: notnull == 0,
    primary_key: pk > 0,
});
```

- [ ] **Step 4: 前端类型**

`src/lib/types.ts` 的 `ColumnInfo` 增加 `primary_key: boolean;`。

- [ ] **Step 5: 验证**

```bash
cd src-tauri && cargo test sqlite:: 2>&1 | tail -5   # sqlite 现有断言仍需通过
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD= cargo test mysql::tests -- --ignored
npm run build
```

在 sqlite 测试里追加断言：`t` 表若没有主键，`list_columns` 返回的 `primary_key` 全为 false；可另建一张 `PRIMARY KEY` 表验证 true。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: expose primary key info in column metadata"
```

---

### Task 2: 后端 `apply_changes`（事务批量写）

**Files:**
- Modify: `src-tauri/src/domain.rs`、`src-tauri/src/driver/mod.rs`、`src-tauri/src/driver/mysql.rs`、`src-tauri/src/driver/sqlite.rs`、`src-tauri/src/service/mod.rs`、`src-tauri/src/commands.rs`、`src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `DbConnection`、`sqlx` 事务
- Produces:
  - `domain::ColumnValue { column: String, value: Option<String> }`
  - `domain::Change`（`Insert{values}` / `Update{pk,values}` / `Delete{pk}`，serde `tag="kind"`）
  - `driver::quote_ident(&str) -> String`
  - `driver::build_change_statements(database, table, &[Change]) -> Vec<BuiltStatement>`（纯函数）
  - `driver::apply_changes(conn, database, table, &[Change]) -> AppResult<()>`
  - 命令 `apply_changes`

- [ ] **Step 1: 写失败测试（纯函数 SQL 构造）**

`src-tauri/src/driver/mod.rs` 内联 `#[cfg(test)]`：

```rust
#[test]
fn builds_insert_update_delete() {
    let changes = vec![
        Change::Insert { values: vec![
            ColumnValue { column: "id".into(), value: Some("9".into()) },
            ColumnValue { column: "name".into(), value: None },
        ]},
        Change::Update { pk: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
            values: vec![ColumnValue { column: "name".into(), value: Some("x".into()) }]},
        Change::Delete { pk: vec![ColumnValue { column: "id".into(), value: Some("2".into()) }]},
    ];
    let stmts = build_change_statements("db", "t", &changes);
    assert_eq!(stmts[0].sql, "INSERT INTO `db`.`t` (`id`, `name`) VALUES (?, ?)");
    assert_eq!(stmts[0].params, vec![Some("9".into()), None]);
    assert_eq!(stmts[1].sql, "UPDATE `db`.`t` SET `name` = ? WHERE `id` = ?");
    assert_eq!(stmts[1].params, vec![Some("x".into()), Some("1".into())]);
    assert_eq!(stmts[2].sql, "DELETE FROM `db`.`t` WHERE `id` = ?");
}

#[test]
fn skips_pk_less_update_and_delete() {
    let changes = vec![
        Change::Update { pk: vec![], values: vec![ColumnValue { column: "a".into(), value: Some("1".into()) }]},
        Change::Delete { pk: vec![] },
    ];
    assert!(build_change_statements("db", "t", &changes).is_empty());
}
```

- [ ] **Step 2: 运行确认失败**

```bash
cd src-tauri && cargo test driver:: -- --nocapture
```

Expected: 编译失败（`Change` / `ColumnValue` / `build_change_statements` 未定义）。

- [ ] **Step 3: 实现 domain.rs 新增类型**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnValue {
    pub column: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Insert { values: Vec<ColumnValue> },
    Update { pk: Vec<ColumnValue>, values: Vec<ColumnValue> },
    Delete { pk: Vec<ColumnValue> },
}
```

- [ ] **Step 4: 实现 driver/mod.rs 的 quote_ident / build_change_statements**

```rust
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

pub struct BuiltStatement {
    pub sql: String,
    pub params: Vec<Option<String>>,
}

pub fn build_change_statements(
    database: &str,
    table: &str,
    changes: &[crate::domain::Change],
) -> Vec<BuiltStatement> {
    use crate::domain::Change;
    let table_ref = format!("{}.{}", quote_ident(database), quote_ident(table));
    let mut out = Vec::new();
    for change in changes {
        match change {
            Change::Insert { values } => {
                if values.is_empty() { continue; }
                let cols: Vec<String> = values.iter().map(|v| quote_ident(&v.column)).collect();
                let ph = vec!["?"; values.len()].join(", ");
                out.push(BuiltStatement {
                    sql: format!("INSERT INTO {} ({}) VALUES ({})", table_ref, cols.join(", "), ph),
                    params: values.iter().map(|v| v.value.clone()).collect(),
                });
            }
            Change::Update { pk, values } => {
                if pk.is_empty() || values.is_empty() { continue; }
                let set: Vec<String> = values.iter().map(|v| format!("{} = ?", quote_ident(&v.column))).collect();
                let wh: Vec<String> = pk.iter().map(|v| format!("{} = ?", quote_ident(&v.column))).collect();
                let mut params: Vec<Option<String>> = values.iter().map(|v| v.value.clone()).collect();
                params.extend(pk.iter().map(|v| v.value.clone()));
                out.push(BuiltStatement {
                    sql: format!("UPDATE {} SET {} WHERE {}", table_ref, set.join(", "), wh.join(" AND ")),
                    params,
                });
            }
            Change::Delete { pk } => {
                if pk.is_empty() { continue; }
                let wh: Vec<String> = pk.iter().map(|v| format!("{} = ?", quote_ident(&v.column))).collect();
                out.push(BuiltStatement {
                    sql: format!("DELETE FROM {} WHERE {}", table_ref, wh.join(" AND ")),
                    params: pk.iter().map(|v| v.value.clone()).collect(),
                });
            }
        }
    }
    out
}

pub async fn apply_changes(
    conn: &DbConnection,
    database: &str,
    table: &str,
    changes: &[crate::domain::Change],
) -> AppResult<()> {
    match conn {
        DbConnection::Sqlite(_) => sqlite::SqliteDriver::apply_changes(conn, database, table, changes).await,
        _ => mysql::MysqlDriver::apply_changes(conn, database, table, changes).await,
    }
}
```

- [ ] **Step 5: 实现 mysql.rs / sqlite.rs 的 apply_changes（事务）**

```rust
// mysql.rs
pub async fn apply_changes(conn: &DbConnection, database: &str, table: &str, changes: &[Change]) -> AppResult<()> {
    let mut tx = conn.as_mysql().begin().await?;
    for stmt in super::build_change_statements(database, table, changes) {
        let mut q = sqlx::query(sqlx::AssertSqlSafe(stmt.sql.as_str()));
        for p in stmt.params { q = q.bind(p); }
        q.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
```

sqlite.rs 相同，只是 `conn.as_sqlite().begin()`。

- [ ] **Step 6: service + 命令**

`service/mod.rs` 加：

```rust
pub struct MutationService;
impl MutationService {
    pub async fn apply_changes(manager: &ConnectionManager, id: &str, database: &str, table: &str, changes: &[Change]) -> AppResult<()> {
        let conn = manager.get(id)?;
        crate::driver::apply_changes(&conn, database, table, changes).await
    }
}
```

`commands.rs` 加 `apply_changes`（参数 `changes: Vec<Change>`），并在 `lib.rs` 的 `generate_handler!` 注册。

- [ ] **Step 7: 跑测试 + 集成测试**

```bash
cd src-tauri && cargo test driver::
```

在 `sqlite.rs` 的测试里补一段真实落库：`apply_changes` 插入/更新/删除，再 `query` 校验行数；并构造「第二条语句失败（如更新一个不存在的列）」验证整体回滚（第一条 INSERT 未生效）。

MySQL 集成测试（`#[ignore]`）同理，用一张临时表验证。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: apply_changes transaction for inline edits"
```

---

### Task 3: 前端类型与 API

**Files:**
- Modify: `src/lib/types.ts`、`src/lib/api.ts`

**Interfaces:**
- Consumes: 后端 `Change` serde 形状
- Produces: `ColumnValue`、`Change`、`api.applyChanges`

- [ ] **Step 1: types.ts**

```ts
export interface ColumnValue { column: string; value: string | null; }

export type Change =
  | { kind: "insert"; values: ColumnValue[] }
  | { kind: "update"; pk: ColumnValue[]; values: ColumnValue[] }
  | { kind: "delete"; pk: ColumnValue[] };
```

（`ColumnInfo` 已在 Task 1 加 `primary_key: boolean`。）

- [ ] **Step 2: api.ts**

```ts
applyChanges: (id: string, database: string, table: string, changes: Change[]) =>
  invoke<void>("apply_changes", { id, database, table, changes }),
```

- [ ] **Step 3: 验证 + Commit**

```bash
npm run build
git add -A && git commit -m "feat: frontend change types and applyChanges api"
```

---

### Task 4: ResultsGrid 可编辑模式

**Files:**
- Modify: `src/components/ResultsGrid.tsx`

**Interfaces:**
- Consumes: `Value`、`Column`
- Produces: 可编辑的行内单元格（双击进入编辑、回车/失焦生效、Esc 取消、NULL 按钮）

- [ ] **Step 1: 扩展 Props 与渲染**

```tsx
export interface EditableConfig {
  columns: string[];                            // 列名（与 rows 顺序一致）
  primaryKeys: string[];                        // 主键列名
  canEditCell: (rowIndex: number, column: string) => boolean;
  isDirty: (rowIndex: number, column: string) => boolean;
  isRowDeleted: (rowIndex: number) => boolean;
  isRowInserted: (rowIndex: number) => boolean;
  rowCount: number;                             // 用于区分“新增行”的索引
  onStartEdit: (rowIndex: number, column: string) => void;
}

interface Props {
  columns: Column[];
  rows: Value[][];
  empty?: string;
  editable?: EditableConfig;
  // 编辑中的单元格：由父组件传入并受控
  editing?: { rowIndex: number; column: string } | null;
  draft?: string;
  draftNull?: boolean;
  onDraftChange?: (v: string) => void;
  onDraftNullChange?: (n: boolean) => void;
  onCommitEdit?: () => void;
  onCancelEdit?: () => void;
}
```

渲染规则：

- 行样式：`isRowDeleted` → 加删除线/红色底；`isRowInserted` → 加浅绿底；`isDirty` 的单元格 → 黄底提示。
- 双击可编辑单元格 → `onStartEdit(rowIndex, column)`；处于 `editing` 的单元格渲染 `<input autoFocus>` + 一个「NULL」切换按钮；`Enter` 提交、`Escape` 取消；输入框失焦也提交。
- 单元格显示值用 `valueToDisplay(v)`；`draftNull` 为 true 时显示 `NULL` 且输入框禁用。
- 主键列不可编辑（`canEditCell` 返回 false）。

- [ ] **Step 2: 验证 + Commit**

```bash
npm run build
git add -A && git commit -m "feat: editable result grid (inline cell edit)"
```

---

### Task 5: TablePanel 暂存 + 改动条 + 提交/回滚

**Files:**
- Modify: `src/components/TablePanel.tsx`

**Interfaces:**
- Consumes: `api.applyChanges`、`api.browseTable`、`api.listColumns`、`ColumnInfo.primary_key`
- Produces: 暂存状态、`buildChanges()`、改动条（新增行 / 提交 / 回滚 / 统计）、提交后重载

- [ ] **Step 1: 暂存状态**

```tsx
type CellMap = Record<string, string | null>;   // column -> 新值（null = NULL）

const [edits, setEdits] = useState<Record<number, CellMap>>({});   // 行索引 -> 修改
const [deleted, setDeleted] = useState<Set<number>>(new Set());
const [inserted, setInserted] = useState<{ id: string; values: CellMap }[]>([]);
const [editing, setEditing] = useState<{ rowIndex: number; column: string } | null>(null);
const [draft, setDraft] = useState("");
const [draftNull, setDraftNull] = useState(false);
const [saving, setSaving] = useState(false);
```

派生：

```tsx
const columnNames = columns.map((c) => c.name);
const primaryKeys = columns.filter((c) => c.primary_key).map((c) => c.name);
const editable = primaryKeys.length > 0;

const displayRows = useMemo(() => {
  const base = (data?.rows ?? []).map((r) => r.slice());
  for (const [ri, cells] of Object.entries(edits)) {
    for (const [col, val] of Object.entries(cells)) {
      const ci = columnNames.indexOf(col);
      if (ci >= 0) base[Number(ri)][ci] = val === null ? { type: "null" } : { type: "str", value: val };
    }
  }
  return base;
}, [data, edits, columnNames]);
```

- [ ] **Step 2: 行主键与 buildChanges**

```tsx
function rowPk(rowIndex: number): ColumnValue[] | null {
  if (!editable) return null;
  const row = data?.rows[rowIndex];
  if (!row) return null;
  return primaryKeys.map((pk) => ({
    column: pk,
    value: rowValueToText(row[columnNames.indexOf(pk)]),
  }));
}

function buildChanges(): Change[] {
  const changes: Change[] = [];
  for (const [ri, cells] of Object.entries(edits)) {
    const pk = rowPk(Number(ri));
    if (pk) changes.push({ kind: "update", pk, values: Object.entries(cells).map(([column, value]) => ({ column, value })) });
  }
  for (const ri of deleted) {
    const pk = rowPk(ri);
    if (pk) changes.push({ kind: "delete", pk });
  }
  for (const ins of inserted) {
    changes.push({ kind: "insert", values: Object.entries(ins.values).map(([column, value]) => ({ column, value })) });
  }
  return changes;
}
```

`rowValueToText`：`Value` → 编辑用文本（`null` → `""`，`bytes` → 空串并置灰，其余 `String(value.value)`）。

- [ ] **Step 3: 编辑回调**

- `onStartEdit(rowIndex, column)`：读取当前单元格原始文本，`setEditing`、`setDraft`、`setDraftNull(false)`。
- `onCommitEdit()`：把 `draftNull ? null : draft` 写进对应行的 `edits`（新增行的 rowIndex 落在 `data.rows.length` 之后时写进 `inserted`），清空 `editing`。
- `onCancelEdit()`：清空 `editing`。

- [ ] **Step 4: 改动条**

在「数据」子标签的工具条附近加一条：

```tsx
{editable && (
  <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
    <Button size="xs" onClick={addRow}>新增行</Button>
    <span className="text-xs text-muted-foreground">
      {Object.keys(edits).length} 处修改 · {inserted.length} 新增 · {deleted.size} 删除
    </span>
    <div className="ml-auto flex gap-1">
      <Button size="xs" variant="outline" disabled={pendingCount === 0 || saving} onClick={rollback}>回滚</Button>
      <Button size="xs" disabled={pendingCount === 0 || saving} onClick={() => void commit()}>
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} 提交
      </Button>
    </div>
  </div>
)}
```

- [ ] **Step 5: commit / rollback**

```tsx
async function commit() {
  if (!activeId) return;
  setSaving(true);
  try {
    await api.applyChanges(activeId, database, table, buildChanges());
    setEdits({}); setDeleted(new Set()); setInserted([]); setEditing(null);
    await load(0, filters, sort);       // 重新加载当前页
  } catch (e) {
    setError(String(e));                 // 保留暂存，提示失败
  } finally { setSaving(false); }
}

function rollback() {
  setEdits({}); setDeleted(new Set()); setInserted([]); setEditing(null); setError(null);
}
```

- [ ] **Step 6: 无主键提示**

当 `!editable` 且已加载列时，在数据区顶部显示一条只读提示。

- [ ] **Step 7: 验证 + Commit**

```bash
npm run build
git add -A && git commit -m "feat: staged inline editing with commit/rollback"
```

---

### Task 6: 端到端联调与 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量验证**

```bash
npm run build
cd src-tauri && cargo test && cargo check
cd ..
```

- [ ] **Step 2: 手动验收（dev 窗口）**

- 打开有主键的表 → 双击单元格改值（回车生效，出现黄色标记与统计）
- 新增一行填值；删除一行（红色标记）
- 点「提交」→ 数据刷新、标记消失；切走再切回确认已落库
- 点「回滚」→ 标记消失、数据不变
- 打开无主键的表 → 显示只读提示、不可编辑
- 故意制造失败（如把某列改成非法值触发约束）→ 提交报错且数据未变

- [ ] **Step 3: README**

在 README「功能」补充阶段 B：表格内增删改 + 暂存/提交/回滚（事务），以及「无主键表只读」。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: phase b feature note in readme"
```

---

## Self-Review

- Spec 覆盖：暂存+提交/回滚（Task 5）、事务（Task 2）、主键定位与无主键只读（Task 1/4/5/6）、NULL 与空串区分（Task 4/5）、参数化绑定（Task 2）。
- 类型一致：`Change` 的 serde `tag="kind"` + `rename_all=lowercase` 对应前端 `kind: "insert"|"update"|"delete"`；`ColumnValue { column, value: string|null }` 与 `Option<String>` 一致。
- 无占位符：各步骤给出可执行命令与关键代码。
