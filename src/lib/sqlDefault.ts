import type { DbFlavor } from "@/lib/types";

const NUMERIC_TYPE =
  /^\s*(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year|bool|boolean)\b/i;

/** 识别「这串东西是 SQL 表达式而不是字符串字面量」 */
const EXPRESSION =
  /^(\d+(\.\d+)?|null|true|false|current_timestamp(\(\d*\))?|current_date|current_time|localtime|now\(\)|unix_timestamp\(\)|uuid\(\)|b'[01]+'|[a-z_][\w$]*\s*\(.*\))$/i;

/**
 * 把用户填的默认值渲染成可直接拼进 SQL 的片段。
 * 数字/布尔类不加引号；`CURRENT_TIMESTAMP`、`NOW()` 这类表达式不加引号；其余当字符串加引号。
 */
export function formatDefault(type: string, raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  // 用户自己写了引号就原样保留
  if (/^'.*'$/s.test(v) || /^".*"$/s.test(v)) return v;
  if (NUMERIC_TYPE.test(type)) return v;
  if (EXPRESSION.test(v)) return v;
  return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/** 默认值输入框的候选，跟着字段类型走 */
export function defaultOptions(type: string, flavor?: DbFlavor): string[] {
  const t = (type || "").toLowerCase();
  if (flavor === "oracle") {
    // Oracle：当前时间用 SYSDATE / SYSTIMESTAMP，字符串还是单引号
    if (/timestamp|datetime/.test(t)) return ["SYSTIMESTAMP", "CURRENT_TIMESTAMP", "NULL"];
    if (/^date/.test(t)) return ["SYSDATE", "TRUNC(SYSDATE)", "CURRENT_DATE", "NULL"];
    if (/^time/.test(t)) return ["NULL"];
    if (/blob|raw|binary/.test(t)) return ["NULL", "EMPTY_BLOB()"];
    if (/clob/.test(t)) return ["NULL", "EMPTY_CLOB()"];
    if (/number|int|decimal|numeric|float|double|real/.test(t)) return ["0", "NULL"];
    return ["NULL", "''"];
  }
  if (/timestamp|datetime/.test(t)) {
    return flavor === "sqlite"
      ? ["CURRENT_TIMESTAMP", "NULL"]
      : ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP()", "NOW()", "NULL"];
  }
  if (/^date/.test(t)) return flavor === "sqlite" ? ["CURRENT_DATE", "NULL"] : ["CURRENT_DATE", "NULL"];
  if (/^time/.test(t)) return flavor === "sqlite" ? ["CURRENT_TIME", "NULL"] : ["CURRENT_TIME", "NULL"];
  if (/bool|tinyint\(1\)/.test(t)) return ["0", "1", "NULL"];
  if (/int|decimal|numeric|float|double|real|year/.test(t)) return ["0", "NULL"];
  if (/json/.test(t)) return flavor === "sqlite" ? ["NULL"] : ["NULL", "JSON_OBJECT()"];
  if (/blob|binary/.test(t)) return ["NULL", "''"];
  return ["NULL", "''"];
}
