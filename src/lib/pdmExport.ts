import type { GraphTable, SchemaGraph } from "./types";

/**
 * 把模型导出成 PowerDesigner `.pdm`（XML）。
 *
 * 输出的是 PowerDesigner 7 以后通用的 XML 结构（`o:RootObject → o:Model → c:Tables`），
 * 我们的解析器（Rust 侧）能把它再读回来，所以「导出 → 打开」可以闭环。
 */

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** 把 `varchar(64)` / `decimal(12,2)` 拆成 PowerDesigner 的 DataType + Length/Precision */
function splitType(rawType: string): { dataType: string; length?: number; precision?: number; scale?: number } {
  const raw = (rawType || "").trim();
  const m = /^([A-Za-z0-9_ ]+?)\s*\((\d+)\s*(?:,\s*(\d+))?\)$/.exec(raw);
  if (!m) return { dataType: raw || "varchar" };
  const base = m[1].trim();
  const first = Number(m[2]);
  const second = m[3] !== undefined ? Number(m[3]) : undefined;
  // TIMESTAMP(6) / INTERVAL DAY(3) 这类括号里是精度，不是长度，原样放进 DataType
  if (/^timestamp/i.test(base) || /^interval/i.test(base)) return { dataType: raw };
  if (second !== undefined) return { dataType: base, precision: first, scale: second };
  return { dataType: base, length: first };
}

/** 数值类型即使没有 (n) 也补一个 Length，PowerDesigner 里看着更顺眼 */
function withDefaultLength<T extends { dataType: string; length?: number }>(t: T): T {
  if (t.length !== undefined) return t;
  if (/^(int|bigint|smallint|tinyint|mediumint|integer|bit|year)$/i.test(t.dataType)) {
    return { ...t, length: /^(bigint)$/i.test(t.dataType) ? 20 : 11 };
  }
  return t;
}

export function graphToPdm(graph: SchemaGraph, modelName: string): string {
  let seq = 10;
  const nextId = () => `o${(seq += 7)}`;

  // 表 / 字段的 Id 要能被外键引用，先建档
  const tableId = new Map<string, string>();
  const columnId = new Map<string, string>(); // `${table}.${column}` → Id
  const tables: GraphTable[] = graph.tables;
  for (const t of tables) {
    tableId.set(t.name, nextId());
    for (const c of t.columns) columnId.set(`${t.name}.${c.name}`, nextId());
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<o:RootObject Id="o1">');
  lines.push("  <c:Children>");
  lines.push('    <o:Model Id="o2">');
  lines.push(`      <a:Name>${esc(modelName)}</a:Name>`);
  lines.push(`      <a:Code>${esc(modelName)}</a:Code>`);
  lines.push("      <c:Tables>");

  for (const t of tables) {
    lines.push(`        <o:Table Id="${tableId.get(t.name)}">`);
    lines.push(`          <a:Name>${esc(t.logical_name || t.name)}</a:Name>`);
    lines.push(`          <a:Code>${esc(t.name)}</a:Code>`);
    if (t.comment) lines.push(`          <a:Comment>${esc(t.comment)}</a:Comment>`);
    lines.push("          <c:Columns>");
    for (const c of t.columns) {
      const ty = withDefaultLength(splitType(c.raw_type));
      lines.push(`            <o:Column Id="${columnId.get(`${t.name}.${c.name}`)}">`);
      lines.push(`              <a:Name>${esc(c.logical_name || c.name)}</a:Name>`);
      lines.push(`              <a:Code>${esc(c.name)}</a:Code>`);
      lines.push(`              <a:DataType>${esc(ty.dataType)}</a:DataType>`);
      if (ty.length !== undefined) lines.push(`              <a:Length>${ty.length}</a:Length>`);
      if (ty.precision !== undefined) lines.push(`              <a:Precision>${ty.precision}</a:Precision>`);
      if (ty.scale !== undefined) lines.push(`              <a:Scale>${ty.scale}</a:Scale>`);
      if (c.comment) lines.push(`              <a:Comment>${esc(c.comment)}</a:Comment>`);
      if (!c.nullable) lines.push("              <a:Mandatory>1</a:Mandatory>");
      lines.push("            </o:Column>");
    }
    lines.push("          </c:Columns>");

    const pk = t.columns.filter((c) => c.primary_key);
    if (pk.length > 0) {
      lines.push("          <c:PrimaryKey>");
      lines.push(`            <o:Key Id="${nextId()}">`);
      lines.push(`              <a:Code>PK_${esc(t.name.toUpperCase())}</a:Code>`);
      lines.push("              <c:Key.Columns>");
      for (const c of pk) {
        lines.push(`                <o:Column Ref="${columnId.get(`${t.name}.${c.name}`)}"/>`);
      }
      lines.push("              </c:Key.Columns>");
      lines.push("            </o:Key>");
      lines.push("          </c:PrimaryKey>");
    }

    const indexes = (t.indexes ?? []).filter((i) => !i.primary);
    if (indexes.length > 0) {
      lines.push("          <c:Indexes>");
      for (const ix of indexes) {
        lines.push(`            <o:Index Id="${nextId()}">`);
        lines.push(`              <a:Name>${esc(ix.name)}</a:Name>`);
        lines.push(`              <a:Code>${esc(ix.name)}</a:Code>`);
        lines.push(`              <a:Unique>${ix.unique ? 1 : 0}</a:Unique>`);
        lines.push("              <c:IndexColumns>");
        for (const col of ix.columns) {
          const ref = columnId.get(`${t.name}.${col}`);
          if (!ref) continue;
          lines.push("                <o:IndexColumn>");
          lines.push("                  <c:Column>");
          lines.push(`                    <o:Column Ref="${ref}"/>`);
          lines.push("                  </c:Column>");
          lines.push("                </o:IndexColumn>");
        }
        lines.push("              </c:IndexColumns>");
        lines.push("            </o:Index>");
      }
      lines.push("          </c:Indexes>");
    }
    lines.push("        </o:Table>");
  }
  lines.push("      </c:Tables>");

  lines.push("      <c:References>");
  graph.edges.forEach((e, i) => {
    const parent = columnId.get(`${e.to_table}.${e.to_column}`);
    const child = columnId.get(`${e.from_table}.${e.from_column}`);
    const parentTable = tableId.get(e.to_table);
    const childTable = tableId.get(e.from_table);
    if (!parent || !child || !parentTable || !childTable) return;
    const name = e.name || `FK_${e.from_table}_${e.to_table}_${i + 1}`;
    lines.push(`        <o:Reference Id="${nextId()}">`);
    lines.push(`          <a:Name>${esc(name)}</a:Name>`);
    lines.push(`          <a:Code>${esc(name)}</a:Code>`);
    lines.push("          <c:ParentTable>");
    lines.push(`            <o:Table Ref="${parentTable}"/>`);
    lines.push("          </c:ParentTable>");
    lines.push("          <c:ChildTable>");
    lines.push(`            <o:Table Ref="${childTable}"/>`);
    lines.push("          </c:ChildTable>");
    lines.push("          <c:Joins>");
    lines.push("            <o:ReferenceJoin>");
    lines.push("              <c:Object1>");
    lines.push(`                <o:Column Ref="${parent}"/>`);
    lines.push("              </c:Object1>");
    lines.push("              <c:Object2>");
    lines.push(`                <o:Column Ref="${child}"/>`);
    lines.push("              </c:Object2>");
    lines.push("            </o:ReferenceJoin>");
    lines.push("          </c:Joins>");
    lines.push("        </o:Reference>");
  });
  lines.push("      </c:References>");
  lines.push("    </o:Model>");
  lines.push("  </c:Children>");
  lines.push("</o:RootObject>");
  return lines.join("\n");
}
