/**
 * Elasticsearch 可视化查询构建器的数据模型与编译逻辑。
 *
 * 结构是一棵 bool 树：每个分组带一个 clause（must / should / must_not / filter），
 * 组里既能放条件，也能放子分组，编译后就是 ES 的 Query DSL。
 */

export type EsClause = "must" | "should" | "must_not" | "filter";

export interface EsCondNode {
  id: string;
  kind: "cond";
  field: string;
  /** term / match / match_phrase / range / exists / wildcard / prefix / regexp */
  op: string;
  value: string;
}

export interface EsGroupNode {
  id: string;
  kind: "group";
  clause: EsClause;
  children: EsNode[];
}

export type EsNode = EsCondNode | EsGroupNode;

export interface EsSortField {
  field: string;
  dir: "asc" | "desc";
}

export interface EsOperatorInfo {
  value: string;
  label: string;
  input: "text" | "bool" | "range";
}

export const ES_OPERATORS: EsOperatorInfo[] = [
  { value: "term", label: "term 精确匹配", input: "text" },
  { value: "match", label: "match 分词匹配", input: "text" },
  { value: "match_phrase", label: "match_phrase 短语", input: "text" },
  { value: "wildcard", label: "wildcard 通配", input: "text" },
  { value: "prefix", label: "prefix 前缀", input: "text" },
  { value: "regexp", label: "regexp 正则", input: "text" },
  { value: "range", label: "range 范围", input: "range" },
  { value: "exists", label: "exists 字段存在", input: "bool" },
];

export const ES_CLAUSES: { value: EsClause; label: string }[] = [
  { value: "must", label: "且 must" },
  { value: "should", label: "或 should" },
  { value: "must_not", label: "非 must_not" },
  { value: "filter", label: "过滤 filter" },
];

export function esOperatorInfo(op: string): EsOperatorInfo {
  return ES_OPERATORS.find((o) => o.value === op) ?? ES_OPERATORS[0];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function newCond(): EsCondNode {
  return { id: uid(), kind: "cond", field: "", op: "term", value: "" };
}

export function newGroup(clause: EsClause = "must"): EsGroupNode {
  return { id: uid(), kind: "group", clause, children: [newCond()] };
}

/** 按 JSON 解析；解析不了就当字符串。 */
function parseJsonOrString(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function compileCond(c: EsCondNode): Record<string, unknown> {
  const f = c.field.trim();
  if (f === "") return {};
  switch (c.op) {
    case "exists":
      return { exists: { field: f } };
    case "wildcard":
      return { wildcard: { [f]: c.value } };
    case "prefix":
      return { prefix: { [f]: c.value } };
    case "regexp":
      return { regexp: { [f]: c.value } };
    case "range": {
      const v = parseJsonOrString(c.value);
      return { range: { [f]: v && typeof v === "object" ? v : {} } };
    }
    case "match":
      return { match: { [f]: parseJsonOrString(c.value) } };
    case "match_phrase":
      return { match_phrase: { [f]: parseJsonOrString(c.value) } };
    default:
      return { term: { [f]: parseJsonOrString(c.value) } };
  }
}

function compileNode(n: EsNode): Record<string, unknown> {
  return n.kind === "group" ? compileGroup(n) : compileCond(n);
}

export function compileGroup(g: EsGroupNode): Record<string, unknown> {
  const parts = g.children.map(compileNode).filter((p) => Object.keys(p).length > 0);
  if (parts.length === 0) return {};
  return { bool: { [g.clause]: parts } };
}

export function compileQuery(root: EsNode): Record<string, unknown> {
  return root.kind === "group" ? compileGroup(root) : compileCond(root);
}

export interface EsBodySpec {
  query: Record<string, unknown>;
  sort: Record<string, unknown>[];
  from: number;
  size: number;
}

export function buildBody(root: EsNode, sorts: EsSortField[], size: number, from: number): EsBodySpec {
  const sort = sorts
    .filter((s) => s.field.trim())
    .map((s) => ({ [s.field.trim()]: s.dir }));
  return { query: compileQuery(root), sort, from, size };
}

/** 生成完整的请求体 JSON（查询为空时就不带 query）。 */
export function bodyJson(spec: EsBodySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (Object.keys(spec.query).length > 0) body.query = spec.query;
  if (spec.sort.length > 0) body.sort = spec.sort;
  if (spec.from > 0) body.from = spec.from;
  if (spec.size > 0) body.size = spec.size;
  return body;
}

/** 预览：POST /<index>/_search + 格式化的 DSL。 */
export function buildPreview(index: string, spec: EsBodySpec): string {
  const body = bodyJson(spec);
  const json = JSON.stringify(body, null, 2);
  return `POST /${index || "<index>"}/_search\n${json}`;
}

/* ---------------- 树操作 ---------------- */

function mapTree(node: EsNode, fn: (n: EsNode) => EsNode): EsNode {
  const next = fn(node);
  if (next.kind === "group") {
    return { ...next, children: next.children.map((c) => mapTree(c, fn)) };
  }
  return next;
}

export function updateNode(root: EsNode, id: string, patch: Record<string, unknown>): EsNode {
  return mapTree(root, (n) => (n.id === id ? ({ ...n, ...patch } as EsNode) : n));
}

export function removeNode(root: EsNode, id: string): EsNode {
  if (root.kind !== "group") return root;
  return {
    ...root,
    children: root.children
      .filter((c) => c.id !== id)
      .map((c) => (c.kind === "group" ? removeNode(c, id) : c)),
  };
}

export function addChild(root: EsNode, parentId: string, child: EsNode): EsNode {
  if (root.kind !== "group") return root;
  if (root.id === parentId) return { ...root, children: [...root.children, child] };
  return {
    ...root,
    children: root.children.map((c) => (c.kind === "group" ? addChild(c, parentId, child) : c)),
  };
}

export function collectFields(root: EsNode): string[] {
  const out: string[] = [];
  const walk = (n: EsNode) => {
    if (n.kind === "group") n.children.forEach(walk);
    else if (n.field.trim()) out.push(n.field.trim());
  };
  walk(root);
  return out;
}
