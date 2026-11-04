/**
 * MongoDB 可视化查询构建器的数据模型与编译逻辑（纯函数，方便单测/复用）。
 *
 * 结构是一棵树：分组（and / or）里既能放条件，也能放子分组，用来表达嵌套条件。
 * 编译时把树编译成 `find` 的 filter 文档，再拼出 `db.<coll>.find(...)` 预览。
 */

export type MongoLogic = "and" | "or";

export interface MongoCondNode {
  id: string;
  kind: "cond";
  field: string;
  /** 操作符，如 $gt / $in / $exists */
  op: string;
  /** 原始输入文本，编译时按 JSON 解析（解析不了就当字符串） */
  value: string;
}

export interface MongoGroupNode {
  id: string;
  kind: "group";
  logic: MongoLogic;
  children: MongoNode[];
}

export type MongoNode = MongoCondNode | MongoGroupNode;

export interface MongoSortField {
  field: string;
  dir: 1 | -1;
}

export interface OperatorInfo {
  value: string;
  label: string;
  /** 值怎么填：text=普通文本、array=数组、bool=开关、number=数字 */
  input: "text" | "array" | "bool" | "number";
}

export const MONGO_OPERATORS: OperatorInfo[] = [
  { value: "$eq", label: "= 等于", input: "text" },
  { value: "$ne", label: "≠ 不等于", input: "text" },
  { value: "$gt", label: "> 大于", input: "text" },
  { value: "$gte", label: "≥ 大于等于", input: "text" },
  { value: "$lt", label: "< 小于", input: "text" },
  { value: "$lte", label: "≤ 小于等于", input: "text" },
  { value: "$in", label: "in 在列表中", input: "array" },
  { value: "$nin", label: "nin 不在列表中", input: "array" },
  { value: "$exists", label: "exists 字段存在", input: "bool" },
  { value: "$regex", label: "regex 正则匹配", input: "text" },
  { value: "$size", label: "size 数组长度", input: "number" },
  { value: "$all", label: "all 数组全包含", input: "array" },
];

export function operatorInfo(op: string): OperatorInfo {
  return MONGO_OPERATORS.find((o) => o.value === op) ?? MONGO_OPERATORS[0];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function newCond(): MongoCondNode {
  return { id: uid(), kind: "cond", field: "", op: "$eq", value: "" };
}

export function newGroup(logic: MongoLogic = "and"): MongoGroupNode {
  return { id: uid(), kind: "group", logic, children: [newCond()] };
}

/** 把一个值按 JSON 解析；不是合法 JSON 就当成普通字符串。 */
function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function parseValue(op: string, raw: string): unknown {
  switch (op) {
    case "$exists":
      return raw === "true";
    case "$size":
      return Number(raw) || 0;
    case "$regex":
      return raw;
    case "$in":
    case "$nin":
    case "$all": {
      const t = raw.trim();
      if (t === "") return [];
      try {
        const v = JSON.parse(t);
        return Array.isArray(v) ? v : [v];
      } catch {
        // 允许逗号分隔的简写：1, 2, 3
        return t.split(",").map((s) => parseScalar(s));
      }
    }
    default:
      return parseScalar(raw);
  }
}

function compileNode(node: MongoNode): Record<string, unknown> {
  if (node.kind === "group") return compileGroup(node);
  const field = node.field.trim();
  if (field === "") return {};
  const v = parseValue(node.op, node.value);
  switch (node.op) {
    case "$eq":
      return { [field]: v };
    case "$ne":
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte":
    case "$in":
    case "$nin":
    case "$exists":
    case "$regex":
    case "$size":
    case "$all":
      return { [field]: { [node.op]: v } };
    default:
      return { [field]: v };
  }
}

export function compileGroup(group: MongoGroupNode): Record<string, unknown> {
  const parts = group.children
    .map(compileNode)
    .filter((p) => Object.keys(p).length > 0);
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  if (group.logic === "or") return { $or: parts };

  // AND：同一层的字段条件（以及 $or 之类）本来就是隐式且，能平铺就平铺；
  // 字段重名或出现复杂子文档时才退回 $and。
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    const ks = Object.keys(p);
    if (ks.length !== 1 || ks[0] in out) return { $and: parts };
    out[ks[0]] = p[ks[0]];
  }
  return out;
}

export function compileFilter(root: MongoNode): Record<string, unknown> {
  return root.kind === "group" ? compileGroup(root) : {};
}

export function compileSort(sorts: MongoSortField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sorts) {
    const f = s.field.trim();
    if (f) out[f] = s.dir;
  }
  return out;
}

/** shell 风格：字段名是合法标识符就不加引号，值按 JSON 渲染。 */
export function toShell(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(toShell).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const body = entries
      .map(([k, v]) => {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        return `${key}: ${toShell(v)}`;
      })
      .join(", ");
    return `{ ${body} }`;
  }
  return String(value);
}

/** 生成预览：db.<coll>.find(<filter>).sort(<sort>).skip(n).limit(n) */
export function buildQuery(
  collection: string,
  filter: Record<string, unknown>,
  sort: Record<string, unknown>,
  skip: number | null,
  limit: number | null,
): string {
  const coll = collection || "collection";
  let out = `db.${coll}.find(${toShell(filter)})`;
  if (Object.keys(sort).length > 0) out += `\n  .sort(${toShell(sort)})`;
  if (skip != null && skip > 0) out += `\n  .skip(${skip})`;
  if (limit != null && limit > 0) out += `\n  .limit(${limit})`;
  return out;
}

/* ---------------- 树操作 ---------------- */

function mapTree(node: MongoNode, fn: (n: MongoNode) => MongoNode): MongoNode {
  const next = fn(node);
  if (next.kind === "group") {
    return { ...next, children: next.children.map((c) => mapTree(c, fn)) };
  }
  return next;
}

/** 按 id 修改一个节点（返回新树）。patch 故意放宽，方便就地改某几个字段。 */
export function updateNode(root: MongoNode, id: string, patch: Record<string, unknown>): MongoNode {
  return mapTree(root, (n) => (n.id === id ? ({ ...n, ...patch } as MongoNode) : n));
}

/** 按 id 删除一个节点（返回新树）。 */
export function removeNode(root: MongoNode, id: string): MongoNode {
  if (root.kind !== "group") return root;
  return {
    ...root,
    children: root.children
      .filter((c) => c.id !== id)
      .map((c) => (c.kind === "group" ? removeNode(c, id) : c)),
  };
}

/** 往某个分组里追加子节点（返回新树）。 */
export function addChild(root: MongoNode, parentId: string, child: MongoNode): MongoNode {
  if (root.kind !== "group") return root;
  if (root.id === parentId) return { ...root, children: [...root.children, child] };
  return {
    ...root,
    children: root.children.map((c) => (c.kind === "group" ? addChild(c, parentId, child) : c)),
  };
}

/** 收集所有条件用到的字段名（给 datalist 去重）。 */
export function collectFields(root: MongoNode): string[] {
  const out: string[] = [];
  const walk = (n: MongoNode) => {
    if (n.kind === "group") n.children.forEach(walk);
    else if (n.field.trim()) out.push(n.field.trim());
  };
  walk(root);
  return out;
}
