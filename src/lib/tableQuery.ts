import type { Filter } from "@/lib/types";

/**
 * 把一条 SQL 还原成「表 + 筛选 + 排序」，让表 tab 能直接用默认的可编辑视图展示，
 * 而不是切成另一套只读结果。解析不了的一律返回 ok:false，由调用方决定怎么兜底。
 */

export interface ParsedTableQuery {
  /** SQL 里写了库名就是它，否则 null（用当前 tab 的库） */
  database: string | null;
  table: string;
  filters: Filter[];
  sort: { column: string; dir: "asc" | "desc" } | null;
}

export type ParseResult =
  | ({ ok: true } & ParsedTableQuery)
  | { ok: false; reason: string };

const IDENT = "(?:`[^`]+`|[A-Za-z_$][\\w$]*)";
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;

/** 去掉注释，保留字符串字面量原样 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (quote !== "`" && sql[i] === "\\") {
          out += sql[i] + (sql[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += quote + quote;
            i += 2;
            continue;
          }
          out += quote;
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\w$]/.test(ch);
}

/** 跳过从 i 开始的引号字符串，返回结束下标之后的位置 */
function skipQuoted(sql: string, i: number): number {
  const quote = sql[i];
  i += 1;
  while (i < sql.length) {
    if (quote !== "`" && sql[i] === "\\") {
      i += 2;
      continue;
    }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/** 找括号深度为 0、不在引号里的关键字位置；`order`/`group` 会顺带确认后面跟 `by` */
function findKeyword(sql: string, keyword: string, from = 0): number {
  const lower = sql.toLowerCase();
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && lower.startsWith(keyword, i) && !isWordChar(sql[i - 1]) && !isWordChar(sql[i + keyword.length])) {
      if (keyword === "order" || keyword === "group") {
        const rest = lower.slice(i + keyword.length);
        const m = /^\s+by\b/.exec(rest);
        if (!m) {
          i += keyword.length;
          continue;
        }
        return i;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/** 顶层（非引号、括号深度 0）的字符位置 */
function findTopLevelChar(sql: string, target: string): number {
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && ch === target) return i;
    i += 1;
  }
  return -1;
}

/** 按顶层 AND 切分；出现 OR 返回 null（表示无法转成 AND 连接的筛选条件） */
function splitByAnd(condition: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let i = 0;
  let start = 0;
  const lower = condition.toLowerCase();
  while (i < condition.length) {
    const ch = condition[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(condition, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && (lower.startsWith("and", i) || lower.startsWith("or", i))) {
      const word = lower.startsWith("and", i) ? "and" : "or";
      if (!isWordChar(condition[i - 1]) && !isWordChar(condition[i + word.length])) {
        const piece = condition.slice(start, i).trim();
        if (piece) parts.push(piece);
        if (word === "or") return null;
        i += word.length;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  const tail = condition.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed[0] === "'" || trimmed[0] === '"' || trimmed[0] === "`") &&
    trimmed[trimmed.length - 1] === trimmed[0]
  ) {
    const quote = trimmed[0];
    const inner = trimmed.slice(1, -1).replace(new RegExp(quote + quote, "g"), quote);
    return quote === "`" ? inner : inner.replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

function lastSegment(name: string): string {
  const parts = name.split(".");
  return unquote(parts[parts.length - 1].trim());
}

/** 单个条件 → Filter；解析不了返回 null */
function parseCondition(text: string): Filter | null {
  const m = new RegExp(`^(${QUALIFIED})\\s*(=|!=|<>|>=|<=|>|<|like)\\s*(.+)$`, "is").exec(text.trim());
  if (!m) return null;
  const column = lastSegment(m[1].replace(/\s+/g, ""));
  let operator = m[2].toLowerCase();
  if (operator === "<>") operator = "!=";
  const rawValue = m[3].trim();
  if (rawValue.includes("(")) return null; // 函数/子查询
  if (/^null$/i.test(rawValue)) return null; // IS NULL 无法用现有筛选表达

  if (operator === "like") {
    // 现有筛选只有「包含」，所以只接受 %x% 这种形状，且不能有其它通配符
    const value = unquote(rawValue);
    if (!/^%.+%$/.test(value) || /[%_]/.test(value.slice(1, -1))) return null;
    return { column, operator, value: value.slice(1, -1) };
  }

  if (/^(true|false)$/i.test(rawValue)) {
    return { column, operator, value: /^true$/i.test(rawValue) ? "1" : "0" };
  }
  if (!/^'.*'$/s.test(rawValue) && !/^".*"$/s.test(rawValue) && !/^-?\d+(\.\d+)?$/.test(rawValue)) {
    return null; // 裸标识符（列比较）等不转
  }
  return { column, operator, value: unquote(rawValue) };
}

/** SELECT 列表：只接受 * 或普通列名（可带表前缀/别名），有函数或表达式就不转 */
function isPlainColumnList(selectList: string): boolean {
  const list = selectList.trim();
  if (list === "*") return true;
  const items = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return false;
  return items.every((item) =>
    new RegExp(`^${QUALIFIED}(?:\\s+(?:as\\s+)?${IDENT})?$`, "i").test(item.replace(/\s+/g, " ")),
  );
}

export function parseTableQuery(input: string): ParseResult {
  const sql = stripComments(input).trim().replace(/;+\s*$/, "").trim();
  if (!sql) return { ok: false, reason: "语句为空" };
  if (findTopLevelChar(sql, ";") >= 0) return { ok: false, reason: "一次只支持一条语句" };
  if (!/^select\b/i.test(sql)) return { ok: false, reason: "只有 SELECT 能转成表格视图" };
  if (findKeyword(sql, "union") >= 0) return { ok: false, reason: "UNION 不支持" };
  if (findKeyword(sql, "join") >= 0) return { ok: false, reason: "JOIN 不支持" };
  if (findKeyword(sql, "group") >= 0 || findKeyword(sql, "having") >= 0) {
    return { ok: false, reason: "GROUP BY / HAVING 不支持" };
  }
  if (/^\s*distinct\b/i.test(sql.slice("select".length))) {
    return { ok: false, reason: "DISTINCT 不支持" };
  }

  const fromIdx = findKeyword(sql, "from");
  if (fromIdx < 0) return { ok: false, reason: "没有 FROM" };
  if (!isPlainColumnList(sql.slice("select".length, fromIdx))) {
    return { ok: false, reason: "SELECT 列表里有表达式或函数" };
  }

  // FROM 之后到下一个子句之间就是表引用
  const afterFrom = sql.slice(fromIdx + "from".length);
  const clauseKeywords = ["where", "order", "limit", "offset", "for", "lock"];
  const ends = clauseKeywords
    .map((k) => findKeyword(afterFrom, k))
    .filter((i) => i >= 0);
  const fromEnd = ends.length > 0 ? Math.min(...ends) : afterFrom.length;
  const tableRef = afterFrom.slice(0, fromEnd).trim();
  if (tableRef.includes(",")) return { ok: false, reason: "只支持单表查询" };

  const tableMatch = new RegExp(
    `^(${IDENT}(?:\\s*\\.\\s*${IDENT})?)(?:\\s+(?:as\\s+)?${IDENT})?$`,
    "i",
  ).exec(tableRef.replace(/\s+/g, " "));
  if (!tableMatch) return { ok: false, reason: "FROM 后面不是单张表" };
  const tableParts = tableMatch[1].replace(/\s+/g, "").split(".");
  const table = unquote(tableParts[tableParts.length - 1]);
  const database = tableParts.length > 1 ? unquote(tableParts[0]) : null;

  // WHERE
  const filters: Filter[] = [];
  const whereIdx = findKeyword(sql, "where");
  if (whereIdx >= 0) {
    const afterWhere = sql.slice(whereIdx + "where".length);
    const stops = clauseKeywords
      .map((k) => findKeyword(afterWhere, k))
      .filter((i) => i >= 0);
    const whereText = afterWhere.slice(0, stops.length > 0 ? Math.min(...stops) : afterWhere.length);
    const parts = splitByAnd(whereText);
    if (!parts) return { ok: false, reason: "WHERE 里有 OR，无法转成筛选条件" };
    for (const part of parts) {
      const filter = parseCondition(part);
      if (!filter) return { ok: false, reason: `条件无法转成筛选：${part}` };
      filters.push(filter);
    }
  }

  // ORDER BY（只支持单列，LIMIT/OFFSET 交给表格分页）
  let sort: { column: string; dir: "asc" | "desc" } | null = null;
  const orderIdx = findKeyword(sql, "order");
  if (orderIdx >= 0) {
    const afterOrder = sql.slice(orderIdx + "order by".length);
    const stops = clauseKeywords
      .map((k) => findKeyword(afterOrder, k))
      .filter((i) => i >= 0);
    const orderText = afterOrder.slice(0, stops.length > 0 ? Math.min(...stops) : afterOrder.length).trim();
    const m = new RegExp(`^(${QUALIFIED})(?:\\s+(asc|desc))?$`, "i").exec(orderText.replace(/\s+/g, " "));
    if (!m) return { ok: false, reason: "ORDER BY 只支持单列" };
    sort = { column: lastSegment(m[1].replace(/\s+/g, "")), dir: (m[2] ?? "asc").toLowerCase() as "asc" | "desc" };
  }

  return { ok: true, database, table, filters, sort };
}
