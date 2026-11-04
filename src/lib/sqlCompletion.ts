/**
 * SQL 补全的排序策略：光标落在哪种位置上，就把哪一类候选排到前面。
 * FROM / JOIN 后面是在选表，SELECT / WHERE / ON 后面是在选字段——
 * 之前一律「字段先于表」，于是写完 FROM 还得往下翻好几条才看到表名。
 */

export type CompletionSlot = "table" | "column" | "keyword";

/** 要写表名的子句 */
const TABLE_CLAUSES = new Set([
  "from",
  "join",
  "into",
  "update",
  "table",
  "describe",
  "desc",
  "truncate",
]);

/** 要写字段名的子句 */
const COLUMN_CLAUSES = new Set([
  "select",
  "where",
  "on",
  "set",
  "having",
  "order by",
  "group by",
]);

const CLAUSE_RE =
  /\b(select|where|on|set|having|order\s+by|group\s+by|from|join|into|update|table|describe|desc|truncate)\b/gi;

/**
 * 取光标前文本里最后一个子句关键字，判断现在该优先给表还是字段。
 * 一句话都还没写（没有子句关键字）时优先给关键字。
 */
export function completionSlot(textBeforeCursor: string): CompletionSlot {
  // 只关心最近的上下文；长脚本里往前翻太多会被更早的子句带偏
  const tail = textBeforeCursor.slice(-400);
  let last: string | null = null;
  for (const m of tail.matchAll(CLAUSE_RE)) {
    last = m[1].toLowerCase().replace(/\s+/g, " ");
  }
  if (last === null) return "keyword";
  if (TABLE_CLAUSES.has(last)) return "table";
  if (COLUMN_CLAUSES.has(last)) return "column";
  return "keyword";
}
