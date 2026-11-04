import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import type { Column, DbFlavor, Filter, ResultSet, Value } from "@/lib/types";

/** 导出格式：CSV / JSON / SQL INSERT */
export type ExportFormat = "csv" | "json" | "sql";

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: "CSV",
  json: "JSON",
  sql: "SQL INSERT",
};

const FORMAT_FILTER: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: "CSV 文件", extensions: ["csv"] },
  json: { name: "JSON 文件", extensions: ["json"] },
  sql: { name: "SQL 文件", extensions: ["sql"] },
};

export function quoteIdent(name: string, flavor?: DbFlavor): string {
  const q = flavor === "sqlite" || flavor === "postgres" || flavor === "oracle" ? '"' : "`";
  return q + name.replace(new RegExp(q, "g"), q + q) + q;
}

/** 单元格的纯文本形式（NULL / 默认 为空串，二进制转十六进制） */
export function cellText(v: Value): string {
  if (v.type === "null" || v.type === "default") return "";
  if (v.type === "bool") return v.value ? "1" : "0";
  if (v.type === "bytes") return v.value.map((b) => b.toString(16).padStart(2, "0")).join("");
  return String(v.value);
}

function csvEscape(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** JSON 片段：数字/布尔保持原生类型，NULL 为 null，二进制转十六进制字符串。 */
export function jsonValue(v: Value): string {
  switch (v.type) {
    case "null":
    case "default":
      return "null";
    case "bool":
      return v.value ? "true" : "false";
    case "int":
    case "uint":
      return String(v.value);
    case "float":
      return Number.isFinite(v.value) ? String(v.value) : "null";
    case "decimal":
      return /^[+-]?[\d.eE+-]+$/.test(v.value) ? v.value : JSON.stringify(v.value);
    case "bytes":
      return JSON.stringify(v.value.map((b) => b.toString(16).padStart(2, "0")).join(""));
    default:
      return JSON.stringify(String(v.value));
  }
}

function sqlLiteral(v: Value, flavor?: DbFlavor): string {
  const pg = flavor === "postgres";
  const oracle = flavor === "oracle";
  switch (v.type) {
    case "null":
    case "default":
      return "NULL";
    case "bool":
      return pg ? (v.value ? "TRUE" : "FALSE") : v.value ? "1" : "0";
    case "int":
    case "uint":
    case "float":
    case "decimal":
      return String(v.value);
    case "bytes": {
      const hex = v.value.map((b) => b.toString(16).padStart(2, "0")).join("");
      if (pg) return `'\\x${hex}'::bytea`;
      // Oracle 的十六进制字面量必须带类型关键字
      return oracle ? `HEXTORAW('${hex.toUpperCase()}')` : `X'${hex}'`;
    }
    default: {
      const s = String(v.value);
      // PostgreSQL 标准字符串里反斜杠是普通字符，只转义单引号
      if (pg) return `'${s.replace(/'/g, "''")}'`;
      // Oracle 同样不认反斜杠转义，且日期要显式转型（会话 NLS 已固定为这个格式）
      if (oracle) {
        const lit = `'${s.replace(/'/g, "''")}'`;
        if (v.type === "date") return `TO_DATE(${lit}, 'YYYY-MM-DD HH24:MI:SS')`;
        if (v.type === "datetime") return `TO_TIMESTAMP(${lit}, 'YYYY-MM-DD HH24:MI:SS.FF')`;
        if (v.type === "time") return `TO_TIMESTAMP(${lit}, 'YYYY-MM-DD HH24:MI:SS.FF')`;
        return lit;
      }
      return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
    }
  }
}

export function resultToCsv(rs: ResultSet): string {
  const lines = [rs.columns.map((c) => csvEscape(c.name)).join(",")];
  for (const row of rs.rows) {
    lines.push(row.map((v) => csvEscape(cellText(v))).join(","));
  }
  return lines.join("\r\n");
}

export function resultToJson(rs: ResultSet): string {
  const rows = rs.rows.map((row) => {
    const pairs = rs.columns.map(
      (c, i) => `${JSON.stringify(c.name)}:${jsonValue(row[i] ?? { type: "null" })}`,
    );
    return `  {${pairs.join(",")}}`;
  });
  return rows.length === 0 ? "[]" : `[\n${rows.join(",\n")}\n]`;
}

export function resultToSqlInsert(rs: ResultSet, tableRef: string, flavor?: DbFlavor): string {
  if (rs.rows.length === 0) return "-- 结果集为空";
  const cols = rs.columns.map((c) => quoteIdent(c.name, flavor)).join(", ");
  const lines = [`-- 由 Myco Studio 导出：${tableRef}`];
  for (const row of rs.rows) {
    const values = row.map((v) => sqlLiteral(v, flavor)).join(", ");
    lines.push(`INSERT INTO ${tableRef} (${cols}) VALUES (${values});`);
  }
  return lines.join("\n");
}

export function rowToTsv(row: Value[]): string {
  return row.map((v) => cellText(v)).join("\t");
}

export function rowToCsv(columns: Column[], row: Value[]): string {
  return [
    columns.map((c) => csvEscape(c.name)).join(","),
    row.map((v) => csvEscape(cellText(v))).join(","),
  ].join("\r\n");
}

export function rowToJson(columns: Column[], row: Value[]): string {
  const pairs = columns.map(
    (c, i) => `  ${JSON.stringify(c.name)}: ${jsonValue(row[i] ?? { type: "null" })}`,
  );
  return `{\n${pairs.join(",\n")}\n}`;
}

/** 单行 Markdown：字段 / 值 两列表格，复制到文档里可读性最好 */
export function rowToMarkdown(columns: Column[], row: Value[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const lines = ["| 字段 | 值 |", "| --- | --- |"];
  columns.forEach((c, i) => {
    const v = row[i];
    lines.push(`| ${esc(c.name)} | ${esc(v && v.type === "null" ? "NULL" : cellText(v ?? { type: "null" }))} |`);
  });
  return lines.join("\n");
}

function contentFor(rs: ResultSet, format: ExportFormat, tableRef: string, flavor?: DbFlavor): string {
  if (format === "json") return resultToJson(rs);
  if (format === "sql") return resultToSqlInsert(rs, tableRef, flavor);
  return "\uFEFF" + resultToCsv(rs);
}

/** 保存结果集为指定格式（前端生成，受结果集 1 万行上限约束） */
export async function saveResultAs(
  rs: ResultSet,
  format: ExportFormat,
  baseName: string,
  tableRef: string,
  flavor?: DbFlavor,
): Promise<string | null> {
  const path = await save({
    defaultPath: `${baseName}.${format}`,
    filters: [FORMAT_FILTER[format]],
  });
  if (!path) return null;
  await api.writeTextFile(path, contentFor(rs, format, tableRef, flavor));
  return path;
}

/** 整表导出：后端流式写文件，不受 1 万行上限约束 */
export async function exportTableAs(
  id: string,
  database: string,
  table: string,
  filters: Filter[],
  sort: { column: string; dir: "asc" | "desc" } | null,
  format: ExportFormat,
  filename: string,
): Promise<{ path: string; count: number } | null> {
  const path = await save({ defaultPath: filename, filters: [FORMAT_FILTER[format]] });
  if (!path) return null;
  const count = await api.exportTable(
    id,
    database,
    table,
    filters,
    sort?.column ?? null,
    sort?.dir ?? null,
    format,
    path,
  );
  return { path, count };
}

export async function pickCsvFile(): Promise<string | null> {
  const file = await open({
    multiple: false,
    filters: [{ name: "CSV 文件", extensions: ["csv", "txt"] }],
  });
  return typeof file === "string" ? file : null;
}

export async function pickSqlFile(): Promise<string | null> {
  const file = await open({
    multiple: false,
    filters: [{ name: "SQL 文件", extensions: ["sql"] }],
  });
  return typeof file === "string" ? file : null;
}
