import type { GraphColumn, GraphEdge, GraphIndex, GraphTable, SchemaGraph } from "./types";

/**
 * 两个「模型」之间的差异。
 *
 * 方向约定：**base = 现状**（一般是从数据库反向工程出来的模型），
 * **target = 期望**（一般是 PDM 设计文件）；生成的 DDL 就是把 base 改成 target。
 */

export type TableStatus = "added" | "removed" | "changed" | "same";

export interface ColumnChange {
  name: string;
  from: GraphColumn;
  to: GraphColumn;
  /** 具体差在哪：类型 / 非空 / 主键 / 注释 */
  reasons: string[];
}

export interface TableDiff {
  name: string;
  status: TableStatus;
  comment: { from: string; to: string } | null;
  addedColumns: GraphColumn[];
  removedColumns: GraphColumn[];
  changedColumns: ColumnChange[];
  addedIndexes: GraphIndex[];
  removedIndexes: GraphIndex[];
  changedIndexes: { from: GraphIndex; to: GraphIndex }[];
  addedFks: GraphEdge[];
  removedFks: GraphEdge[];
}

export interface ModelDiff {
  tables: TableDiff[];
  summary: { added: number; removed: number; changed: number; same: number };
  counts: { columns: number; indexes: number; foreignKeys: number };
}

const norm = (s: string) => s.trim().toLowerCase();
const typeOf = (c: GraphColumn) => norm(c.raw_type);
const indexKey = (i: GraphIndex) => `${i.name.toLowerCase()}|${i.columns.map(norm).join(",")}|${i.unique}`;
const fkKey = (e: GraphEdge) =>
  `${e.from_table}.${e.from_column}->${e.to_table}.${e.to_column}`.toLowerCase();

function columnReasons(from: GraphColumn, to: GraphColumn): string[] {
  const reasons: string[] = [];
  if (typeOf(from) !== typeOf(to)) reasons.push(`类型 ${from.raw_type} → ${to.raw_type}`);
  if (from.nullable !== to.nullable) reasons.push(to.nullable ? "改为可空" : "改为非空");
  if (from.primary_key !== to.primary_key) reasons.push(to.primary_key ? "加主键" : "去主键");
  if ((from.comment ?? "").trim() !== (to.comment ?? "").trim()) reasons.push("注释不同");
  return reasons;
}

function diffTable(base: GraphTable | undefined, target: GraphTable | undefined): TableDiff | null {
  const name = target?.name ?? base?.name ?? "";
  if (!base && target) {
    return {
      name,
      status: "added",
      comment: { from: "", to: target.comment ?? "" },
      addedColumns: target.columns,
      removedColumns: [],
      changedColumns: [],
      addedIndexes: (target.indexes ?? []).filter((i) => !i.primary),
      removedIndexes: [],
      changedIndexes: [],
      addedFks: [],
      removedFks: [],
    };
  }
  if (base && !target) {
    return {
      name,
      status: "removed",
      comment: { from: base.comment ?? "", to: "" },
      addedColumns: [],
      removedColumns: base.columns,
      changedColumns: [],
      addedIndexes: [],
      removedIndexes: (base.indexes ?? []).filter((i) => !i.primary),
      changedIndexes: [],
      addedFks: [],
      removedFks: [],
    };
  }
  if (!base || !target) return null;

  const targetCols = new Map(target.columns.map((c) => [norm(c.name), c]));
  const baseCols = new Map(base.columns.map((c) => [norm(c.name), c]));
  const addedColumns = target.columns.filter((c) => !baseCols.has(norm(c.name)));
  const removedColumns = base.columns.filter((c) => !targetCols.has(norm(c.name)));
  const changedColumns: ColumnChange[] = [];
  for (const [key, from] of baseCols) {
    const to = targetCols.get(key);
    if (!to) continue;
    const reasons = columnReasons(from, to);
    if (reasons.length > 0) changedColumns.push({ name: to.name, from, to, reasons });
  }

  const baseIdx = new Map((base.indexes ?? []).filter((i) => !i.primary).map((i) => [i.name.toLowerCase(), i]));
  const targetIdx = new Map((target.indexes ?? []).filter((i) => !i.primary).map((i) => [i.name.toLowerCase(), i]));
  const addedIndexes = [...targetIdx].filter(([k]) => !baseIdx.has(k)).map(([, v]) => v);
  const removedIndexes = [...baseIdx].filter(([k]) => !targetIdx.has(k)).map(([, v]) => v);
  const changedIndexes = [...targetIdx]
    .filter(([k, v]) => baseIdx.has(k) && indexKey(baseIdx.get(k) as GraphIndex) !== indexKey(v))
    .map(([k, v]) => ({ from: baseIdx.get(k) as GraphIndex, to: v }));

  const baseComment = base.comment ?? "";
  const targetComment = target.comment ?? "";
  const commentChanged =
    baseComment.trim() !== targetComment.trim() ? { from: baseComment, to: targetComment } : null;

  const changed =
    addedColumns.length > 0 ||
    removedColumns.length > 0 ||
    changedColumns.length > 0 ||
    addedIndexes.length > 0 ||
    removedIndexes.length > 0 ||
    changedIndexes.length > 0 ||
    commentChanged !== null;

  return {
    name,
    status: changed ? "changed" : "same",
    comment: commentChanged,
    addedColumns,
    removedColumns,
    changedColumns,
    addedIndexes,
    removedIndexes,
    changedIndexes,
    addedFks: [],
    removedFks: [],
  };
}

/** 对比两个模型 */
export function diffModels(base: SchemaGraph, target: SchemaGraph): ModelDiff {
  const baseTables = new Map(base.tables.map((t) => [norm(t.name), t]));
  const targetTables = new Map(target.tables.map((t) => [norm(t.name), t]));
  const names = [...new Set([...baseTables.keys(), ...targetTables.keys()])];

  const tables: TableDiff[] = [];
  for (const key of names.sort()) {
    const diff = diffTable(baseTables.get(key), targetTables.get(key));
    if (diff) tables.push(diff);
  }

  // 外键按「子表.子列 → 父表.父列」比对
  const baseFks = new Set(base.edges.map(fkKey));
  const targetFks = new Map(target.edges.map((e) => [fkKey(e), e]));
  const removedFkSet = new Set([...baseFks].filter((k) => !targetFks.has(k)));
  for (const edge of base.edges) {
    if (!removedFkSet.has(fkKey(edge))) continue;
    const t = tables.find((x) => norm(x.name) === norm(edge.from_table));
    if (t) t.removedFks.push(edge);
  }
  for (const [key, edge] of targetFks) {
    if (baseFks.has(key)) continue;
    const t = tables.find((x) => norm(x.name) === norm(edge.from_table));
    if (t) {
      t.addedFks.push(edge);
      if (t.status === "same") t.status = "changed";
    }
  }

  const summary = {
    added: tables.filter((t) => t.status === "added").length,
    removed: tables.filter((t) => t.status === "removed").length,
    changed: tables.filter((t) => t.status === "changed").length,
    same: tables.filter((t) => t.status === "same").length,
  };
  const counts = {
    columns:
      tables.reduce((n, t) => n + t.addedColumns.length + t.removedColumns.length + t.changedColumns.length, 0),
    indexes: tables.reduce(
      (n, t) => n + t.addedIndexes.length + t.removedIndexes.length + t.changedIndexes.length,
      0,
    ),
    foreignKeys: tables.reduce((n, t) => n + t.addedFks.length + t.removedFks.length, 0),
  };
  return { tables, summary, counts };
}

/** 一条可选中的改动（界面上带勾选框、能生成 SQL） */
export interface ModelChange {
  id: string;
  kind:
    | "table_added"
    | "table_removed"
    | "column_added"
    | "column_removed"
    | "column_changed"
    | "index_added"
    | "index_removed"
    | "index_changed"
    | "fk_added"
    | "fk_removed"
    | "comment_changed";
  table: string;
  /** 展示用的一句话 */
  label: string;
  /** 默认不勾选：删表 / 删列 / 删索引这类破坏性改动 */
  destructive: boolean;
  column?: string;
  from?: GraphColumn;
  to?: GraphColumn;
  index?: GraphIndex;
  indexTo?: GraphIndex;
  edge?: GraphEdge;
  comment?: { from: string; to: string };
}

/** 把结构化 diff 摊平成可勾选的改动列表 */
export function diffToChanges(diff: ModelDiff): ModelChange[] {
  const out: ModelChange[] = [];
  const push = (c: Omit<ModelChange, "id">) => out.push({ ...c, id: `${c.kind}:${c.table}:${c.column ?? c.index?.name ?? ""}` });
  for (const t of diff.tables) {
    // 整张表新建 / 删除时，字段、索引、注释都已经包含在那一条语句里，
    // 不能再展开成单独的改动（否则会重复生成 ADD COLUMN 之类的语句）；
    // 但**外键要单独列出来**——建表语句里不带外键（目标表可能还没建），
    // 必须等所有表都建完再 ADD CONSTRAINT。
    if (t.status === "added") {
      push({ kind: "table_added", table: t.name, label: `新建表 ${t.name}`, destructive: false });
      for (const e of t.addedFks) {
        push({
          kind: "fk_added",
          table: t.name,
          edge: e,
          label: `加外键 ${e.from_table}.${e.from_column} → ${e.to_table}.${e.to_column}`,
          destructive: false,
        });
      }
      continue;
    }
    if (t.status === "removed") {
      push({ kind: "table_removed", table: t.name, label: `删除表 ${t.name}（库里多出来的）`, destructive: true });
      continue;
    }
    for (const c of t.addedColumns) {
      push({ kind: "column_added", table: t.name, column: c.name, to: c, label: `加字段 ${t.name}.${c.name} ${c.raw_type}`, destructive: false });
    }
    for (const c of t.removedColumns) {
      push({ kind: "column_removed", table: t.name, column: c.name, from: c, label: `删字段 ${t.name}.${c.name}`, destructive: true });
    }
    for (const c of t.changedColumns) {
      push({
        kind: "column_changed",
        table: t.name,
        column: c.name,
        from: c.from,
        to: c.to,
        label: `改字段 ${t.name}.${c.name}：${c.reasons.join("；")}`,
        destructive: false,
      });
    }
    for (const ix of t.addedIndexes) {
      push({ kind: "index_added", table: t.name, index: ix, label: `加索引 ${ix.name} (${ix.columns.join(", ")})`, destructive: false });
    }
    for (const ix of t.removedIndexes) {
      push({ kind: "index_removed", table: t.name, index: ix, label: `删索引 ${ix.name}`, destructive: true });
    }
    for (const ix of t.changedIndexes) {
      push({ kind: "index_changed", table: t.name, index: ix.from, indexTo: ix.to, label: `索引 ${ix.from.name} 列有变化`, destructive: true });
    }
    for (const e of t.addedFks) {
      push({ kind: "fk_added", table: t.name, edge: e, label: `加外键 ${e.from_table}.${e.from_column} → ${e.to_table}.${e.to_column}`, destructive: false });
    }
    for (const e of t.removedFks) {
      push({ kind: "fk_removed", table: t.name, edge: e, label: `删外键 ${e.from_table}.${e.from_column}`, destructive: true });
    }
    if (t.comment) {
      push({ kind: "comment_changed", table: t.name, comment: t.comment, label: `改表注释 ${t.name}`, destructive: false });
    }
  }
  return out;
}
