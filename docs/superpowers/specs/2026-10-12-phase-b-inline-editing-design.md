# 阶段 B：结果表格内增删改 + 事务控制 · 设计文档

- 日期：2026-10-12
- 状态：设计已确认（待写实现计划）
- 前置：阶段 A（只读浏览）已上线
- 关联：[阶段 A 设计](./2026-10-10-database-client-design.md)

## 1. 目标

在「表数据」视图中直接编辑数据，并且安全落库：

- 单元格修改（UPDATE）
- 新增行（INSERT）
- 删除行（DELETE）
- 所有改动先在本地**暂存**，点「提交」后放进**一个数据库事务**一次性执行；「回滚」丢弃本地改动。

非目标（YAGNI）：不改表结构（DDL）、不做批量导入/导出（属阶段 C）、不做跨表编辑。

## 2. 交互

- 「数据」子标签内的单元格：双击进入编辑，回车或失焦生效，Esc 取消。
- 每行最左侧提供「删除行」操作；表格工具条上有「新增行」按钮。
- 一条改动条：显示统计（如 `3 处修改 · 1 新增 · 2 删除`）与「提交」「回滚」按钮。
- 本地暂存并高亮标记：已修改、待新增、待删除。
- 只读场景：表无主键时不可编辑，界面给出提示。

## 3. 行定位与主键

- UPDATE / DELETE 通过**主键**定位：`WHERE 主键1 = ? AND 主键2 = ?`。
- 因此需要主键列信息：列元数据新增字段 `primary_key: bool`。
  - MySQL：`information_schema.COLUMNS.COLUMN_KEY = 'PRI'`
  - SQLite：`pragma_table_info(...).pk > 0`
- **无主键的表 → 只读**（安全底线，避免误改多行）。

## 4. 后端

新增命令 `apply_changes(connection_id, database, table, changes)`：

```
Change =
  | Insert { values: Map<column, Option<string>> }
  | Update { pk: Map<column, string>, values: Map<column, Option<string>> }
  | Delete { pk: Map<column, string> }
```

- 在一个事务内执行：`BEGIN → 逐条执行 → COMMIT`；任一条失败则整体 `ROLLBACK`，并把原始错误返回前端。
- SQL 构造全部使用**参数化绑定**（标识符用反引号包裹并转义，值走占位符）。
- `Option<string> = None` 表示写入 `NULL`。
- 兼容 MySQL 协议族与 SQLite（同一套接口，按连接类型分发）。

## 5. 前端

- `ResultsGrid` 增加可编辑模式，接收 `EditableConfig`：
  - `primaryKeys: string[]`
  - `columnMeta: Record<column, { nullable: boolean }>`
  - 暂存值映射与编辑/删除回调
- `TablePanel` 负责暂存状态、统计与「提交 / 回滚」。
- 提交成功后按当前筛选/排序/分页**重新加载数据**，并清空暂存；失败则保留暂存并提示错误。

## 6. 值 / NULL 处理

- 单元格用文本输入；提供「设为 NULL」；空输入表示空串（与 NULL 区分）。
- 第 1 万行之后（未加载）不可编辑。

## 7. 测试

- Rust：`apply_changes` 的 SQL 构造单元测试（INSERT/UPDATE/DELETE + NULL + 标识符转义）；
- Rust：对真实 MySQL 的集成测试（`#[ignore]`）：建临时表→插入→更新→删除→校验，并验证事务回滚（故意让第二条失败，确认第一条未落库）。
- 前端：靠构建 + 手动验收。

## 8. 关键决策记录

1. 采用「暂存 + 提交/回滚」模型（而非即时落库），以获得事务控制与可回滚能力。
2. 以主键定位行；无主键表只读。
3. 提交走单事务，失败整体回滚。
