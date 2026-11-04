import type { SchemaGraph } from "./types";
import { mapType, type SqlDialect } from "./sqlTypes";

/**
 * ER 图的文本导出（DbML / Mermaid / DDL 表格清单）。
 * 只输出库里真实存在的外键，不做任何推断。
 */

/** DbML：https://dbml.dbdiagram.io —— 可以直接粘进 dbdiagram.io 看 */
export function graphToDbml(graph: SchemaGraph): string {
  const lines: string[] = [];
  for (const t of graph.tables) {
    lines.push(`Table "${t.name}" {`);
    for (const c of t.columns) {
      const attrs: string[] = [];
      if (c.primary_key) attrs.push("pk");
      if (!c.nullable) attrs.push("not null");
      // DbML 的类型名里不能有空格
      const type = (c.raw_type || "unknown").replace(/\s+/g, "_");
      lines.push(`  "${c.name}" ${type}${attrs.length ? ` [${attrs.join(", ")}]` : ""}`);
    }
    lines.push("}\n");
  }
  for (const e of graph.edges) {
    lines.push(`Ref: "${e.from_table}"."${e.from_column}" > "${e.to_table}"."${e.to_column}"`);
  }
  return lines.join("\n");
}

/** Mermaid erDiagram：粘进 Markdown / 语雀 / GitHub 就能渲染 */
export function graphToMermaid(graph: SchemaGraph): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  const lines = ["erDiagram"];
  for (const e of graph.edges) {
    lines.push(`  ${safe(e.to_table)} ||--o{ ${safe(e.from_table)} : "${e.from_column}"`);
  }
  for (const t of graph.tables) {
    lines.push(`  ${safe(t.name)} {`);
    for (const c of t.columns) {
      const type = (c.raw_type || "unknown").replace(/[^A-Za-z0-9_]/g, "_");
      lines.push(`    ${type} ${safe(c.name)}${c.primary_key ? " PK" : c.foreign_key ? " FK" : ""}`);
    }
    lines.push("  }");
  }
  return lines.join("\n");
}

/** 表清单（Markdown），给没法看图的场合用 */
export function graphToMarkdown(graph: SchemaGraph): string {
  const lines: string[] = [`# 数据模型（${graph.tables.length} 张表 / ${graph.edges.length} 条外键）`, ""];
  for (const t of graph.tables) {
    lines.push(`## ${t.name}`, "", "| 列 | 类型 | 键 | 可空 |", "| --- | --- | --- | --- |");
    for (const c of t.columns) {
      const key = c.primary_key ? "PK" : c.foreign_key ? "FK" : "";
      lines.push(`| ${c.name} | ${c.raw_type} | ${key} | ${c.nullable ? "是" : "否"} |`);
    }
    lines.push("");
  }
  if (graph.edges.length > 0) {
    lines.push("## 外键关系", "");
    for (const e of graph.edges) {
      lines.push(`- ${e.from_table}.${e.from_column} → ${e.to_table}.${e.to_column}`);
    }
  }
  return lines.join("\n");
}

/** 只按模型生成 DDL（PDM 文件里没有 DDL，靠这个导出建表语句） */
export function graphToDdl(graph: SchemaGraph, flavor: "mysql" | "postgres" | "oracle" = "mysql"): string {
  const q = (s: string) => (flavor === "mysql" ? `\`${s}\`` : `"${s}"`);
  const lines: string[] = ["-- 由 Myco Studio 从数据模型生成", ""];
  for (const t of graph.tables) {
    const defs: string[] = [];
    for (const c of t.columns) {
      const type = mapType(c.raw_type || "varchar(255)", flavor as SqlDialect);
      defs.push(`  ${q(c.name)} ${type}${c.nullable ? "" : " NOT NULL"}`);
    }
    const pk = t.columns.filter((c) => c.primary_key).map((c) => q(c.name));
    if (pk.length > 0) defs.push(`  PRIMARY KEY (${pk.join(", ")})`);
    lines.push(`CREATE TABLE ${q(t.name)} (`);
    lines.push(defs.join(",\n"));
    lines.push(");");
    if (t.comment && flavor !== "oracle") {
      lines.push(`COMMENT ON TABLE ${q(t.name)} IS '${t.comment.replace(/'/g, "''")}';`);
    }
    for (const ix of t.indexes ?? []) {
      if (ix.primary) continue;
      lines.push(
        `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(ix.name)} ON ${q(t.name)} (${ix.columns
          .map(q)
          .join(", ")});`,
      );
    }
    lines.push("");
  }
  for (const e of graph.edges) {
    const name = q(e.name || `FK_${e.from_table}_${e.to_table}`);
    lines.push(
      `ALTER TABLE ${q(e.from_table)} ADD CONSTRAINT ${name} FOREIGN KEY (${q(e.from_column)}) ` +
        `REFERENCES ${q(e.to_table)} (${q(e.to_column)});`,
    );
  }
  return lines.join("\n");
}
