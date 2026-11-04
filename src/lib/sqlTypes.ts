export type SqlDialect = "mysql" | "postgres" | "oracle" | "sqlite";

/**
 * 把「模型里的类型」翻译成目标数据库的类型。
 *
 * 模型可能来自 MySQL 风格的 PDM（`bigint(20)` / `datetime` / `tinyint(1)`），
 * 直接拿去建 Oracle 表会失败（Oracle 没有 datetime/bigint，而且长度不能叠加成
 * `NUMBER(19)(20)` 这种写法）。所以这里按「基础类型 + 参数」重新拼，而不是替换单词。
 */

interface ParsedType {
  base: string;
  args: number[];
}

function parse(raw: string): ParsedType {
  const text = (raw || "").trim();
  const m = /^([A-Za-z0-9_ ]+?)\s*\(([^)]*)\)\s*$/.exec(text);
  if (!m) return { base: text.toLowerCase(), args: [] };
  const args = m[2]
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return { base: m[1].trim().toLowerCase(), args };
}

const isText = (b: string) => /^(varchar|nvarchar|varchar2|nvarchar2|char|nchar|character|character varying)$/.test(b);
const isBigText = (b: string) => /^(text|tinytext|mediumtext|longtext|clob|nclob|long|ntext)$/.test(b);
const isBlob = (b: string) => /^(blob|tinyblob|mediumblob|longblob|binary|varbinary|bytea|raw|long raw|image)$/.test(b);
const isInt = (b: string) => /^(int|integer|mediumint|smallint|tinyint|int2|int4)$/.test(b);
const isBigInt = (b: string) => /^(bigint|int8)$/.test(b);
const isDecimal = (b: string) => /^(decimal|numeric|number|money|smallmoney)$/.test(b);
const isFloat = (b: string) => /^(float|real)$/.test(b);
const isDouble = (b: string) => /^(double|double precision|binary_double)$/.test(b);
const isDateTime = (b: string) => /^(datetime|timestamp|timestamp without time zone)$/.test(b);
const isTime = (b: string) => /^(time|time without time zone)$/.test(b);
const isBool = (b: string) => /^(bool|boolean|bit)$/.test(b);
const isJson = (b: string) => /^(json|jsonb)$/.test(b);

function argsText(args: number[], fallback?: number[]): string {
  const list = args.length > 0 ? args : (fallback ?? []);
  return list.length > 0 ? `(${list.join(",")})` : "";
}

export function mapType(raw: string, dialect: SqlDialect): string {
  const { base, args } = parse(raw);
  if (!base) return raw;
  if (dialect === "sqlite") return raw; // SQLite 动态类型，原样即可

  if (dialect === "oracle") {
    if (isText(base)) return `VARCHAR2${argsText(args, [255])}`;
    if (isBigText(base)) return "CLOB";
    if (isBlob(base)) return "BLOB";
    if (isBigInt(base)) return `NUMBER${argsText(args.length ? [Math.min(args[0], 19)] : [19])}`;
    if (base === "tinyint" && args[0] === 1) return "NUMBER(1)";
    if (isInt(base)) return `NUMBER${argsText(args, [10])}`;
    if (isDecimal(base)) return `NUMBER${argsText(args)}`;
    if (isFloat(base)) return "BINARY_FLOAT";
    if (isDouble(base)) return "BINARY_DOUBLE";
    if (isDateTime(base)) return "TIMESTAMP";
    if (base === "date") return "DATE";
    if (isTime(base)) return "VARCHAR2(8)";
    if (isBool(base)) return "NUMBER(1)";
    if (isJson(base)) return "CLOB";
    return raw.toUpperCase();
  }

  if (dialect === "postgres") {
    if (isBigText(base)) return "text";
    if (isBlob(base)) return "bytea";
    if (isBigInt(base)) return "bigint";
    if (base === "tinyint") return "smallint";
    if (base === "mediumint") return "integer";
    if (base === "int" || base === "integer") return "integer";
    if (base === "smallint") return "smallint";
    if (isDecimal(base)) return `numeric${argsText(args)}`;
    if (isFloat(base)) return "real";
    if (isDouble(base)) return "double precision";
    if (isDateTime(base)) return "timestamp";
    if (isBool(base)) return "boolean";
    if (isJson(base)) return "jsonb";
    if (base === "varchar2") return `varchar${argsText(args)}`;
    if (base === "clob") return "text";
    return raw.toLowerCase();
  }

  // MySQL
  if (base === "varchar2") return `varchar${argsText(args, [255])}`;
  if (base === "number") return `decimal${argsText(args)}`;
  if (base === "boolean") return "tinyint(1)";
  if (base === "bytea") return "blob";
  if (base === "jsonb") return "json";
  if (base === "text" && args.length === 0) return "text";
  if (base === "timestamp without time zone") return "datetime";
  if (isBlob(base) && base !== "blob") return "blob";
  return raw;
}
