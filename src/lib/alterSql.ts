import type { DbFlavor, GraphIndex, GraphTable } from "./types";
import type { ModelChange } from "./modelDiff";
import { mapType } from "./sqlTypes";

/**
 * 把「对比出来的改动」翻译成 ALTER 语句。
 *
 * 只生成**把现状改成目标**需要的语句；删表 / 删列这类破坏性改动只有在调用方
 * 明确勾选时才会进来（界面上默认不勾）。
 */

export type Dialect = "mysql" | "postgres" | "oracle" | "sqlite";

export function dialectOf(flavor: DbFlavor | undefined): Dialect {
  if (flavor === "postgres") return "postgres";
  if (flavor === "oracle") return "oracle";
  if (flavor === "sqlite") return "sqlite";
  return "mysql";
}

function quote(name: string, d: Dialect): string {
  return d === "mysql" ? `\`${name}\`` : `"${name}"`;
}

const q = quote;

/** 建表语句（新建表时用；字段 / 主键 / 索引一起出来） */
export function createTableSql(table: GraphTable, d: Dialect): string[] {
  const defs: string[] = [];
  for (const c of table.columns) {
    const type = mapType(c.raw_type || "varchar(255)", d);
    defs.push(`  ${q(c.name, d)} ${type}${c.nullable ? "" : " NOT NULL"}`);
  }
  const pk = table.columns.filter((c) => c.primary_key).map((c) => q(c.name, d));
  if (pk.length > 0) defs.push(`  PRIMARY KEY (${pk.join(", ")})`);
  const out = [`CREATE TABLE ${q(table.name, d)} (\n${defs.join(",\n")}\n);`];
  if (table.comment) {
    out.push(
      d === "mysql"
        ? `ALTER TABLE ${q(table.name, d)} COMMENT = '${esc(table.comment)}';`
        : `COMMENT ON TABLE ${q(table.name, d)} IS '${esc(table.comment)}';`,
    );
  }
  for (const c of table.columns) {
    if (c.comment) out.push(commentOnColumn(table.name, c.name, c.comment, d));
  }
  for (const ix of (table.indexes ?? []).filter((i) => !i.primary)) {
    out.push(createIndexSql(table.name, ix, d));
  }
  return out.filter(Boolean);
}

const esc = (s: string) => s.replace(/'/g, "''");

function commentOnColumn(table: string, column: string, comment: string, d: Dialect): string {
  if (d === "mysql") {
    // MySQL 的列注释只能跟着列定义走，单独一条 MODIFY 会把类型写丢，
    // 所以这里只提示、不自动生成
    return `-- MySQL 列注释需要在 MODIFY COLUMN 里带上：${table}.${column} = '${esc(comment)}'`;
  }
  return `COMMENT ON COLUMN ${q(table, d)}.${q(column, d)} IS '${esc(comment)}';`;
}

export function createIndexSql(table: string, ix: GraphIndex, d: Dialect): string {
  const unique = ix.unique ? "UNIQUE " : "";
  return `CREATE ${unique}INDEX ${q(ix.name, d)} ON ${q(table, d)} (${ix.columns
    .map((c) => q(c, d))
    .join(", ")});`;
}

function dropIndexSql(table: string, ix: GraphIndex, d: Dialect): string {
  return d === "mysql"
    ? `DROP INDEX ${q(ix.name, d)} ON ${q(table, d)};`
    : `DROP INDEX ${q(ix.name, d)};`;
}

/** 单条改动 → SQL（可能多条） */
export function changeToSql(change: ModelChange, d: Dialect, table?: GraphTable): string[] {
  const t = q(change.table, d);
  switch (change.kind) {
    case "table_added":
      return table ? createTableSql(table, d) : [`-- 缺表定义：${change.table}`];
    case "table_removed":
      return [`DROP TABLE ${t};`];
    case "column_added": {
      const c = change.to;
      if (!c) return [];
      const notNull = c.nullable ? "" : " NOT NULL";
      const colType = mapType(c.raw_type, d);
      const sql =
        d === "oracle"
          ? `ALTER TABLE ${t} ADD (${q(c.name, d)} ${colType}${notNull});`
          : `ALTER TABLE ${t} ADD COLUMN ${q(c.name, d)} ${colType}${notNull};`;
      const out = [sql];
      if (c.comment) out.push(commentOnColumn(change.table, c.name, c.comment, d));
      return out;
    }
    case "column_removed":
      return [`ALTER TABLE ${t} DROP COLUMN ${q(change.column as string, d)};`];
    case "column_changed": {
      const { from, to } = change;
      if (!from || !to) return [];
      const out: string[] = [];
      const typeChanged = from.raw_type.trim().toLowerCase() !== to.raw_type.trim().toLowerCase();
      const nullChanged = from.nullable !== to.nullable;
      if (to.comment && from.comment !== to.comment) {
        out.push(commentOnColumn(change.table, to.name, to.comment, d));
      }
      if (!typeChanged && !nullChanged) return out;
      const type = mapType(typeChanged ? to.raw_type : from.raw_type, d);
      if (d === "mysql") {
        out.push(
          `ALTER TABLE ${t} MODIFY COLUMN ${q(to.name, d)} ${type}${to.nullable ? " NULL" : " NOT NULL"}` +
            `${to.comment ? ` COMMENT '${esc(to.comment)}'` : ""};`,
        );
      } else if (d === "postgres") {
        if (typeChanged) out.push(`ALTER TABLE ${t} ALTER COLUMN ${q(to.name, d)} TYPE ${type};`);
        if (nullChanged) {
          out.push(
            `ALTER TABLE ${t} ALTER COLUMN ${q(to.name, d)} ${to.nullable ? "DROP NOT NULL" : "SET NOT NULL"};`,
          );
        }
      } else if (d === "oracle") {
        out.push(
          `ALTER TABLE ${t} MODIFY (${q(to.name, d)}${typeChanged ? ` ${type}` : ""}` +
            `${nullChanged ? (to.nullable ? " NULL" : " NOT NULL") : ""});`,
        );
      } else {
        out.push(`-- SQLite 不支持直接改列类型：${change.table}.${to.name}`);
      }
      return out;
    }
    case "index_added":
      return change.index ? [createIndexSql(change.table, change.index, d)] : [];
    case "index_removed":
      return change.index ? [dropIndexSql(change.table, change.index, d)] : [];
    case "index_changed": {
      const out: string[] = [];
      if (change.index) out.push(dropIndexSql(change.table, change.index, d));
      if (change.indexTo) out.push(createIndexSql(change.table, change.indexTo, d));
      return out;
    }
    case "fk_added": {
      const e = change.edge;
      if (!e) return [];
      const name = e.name || `FK_${e.from_table}_${e.to_table}`;
      return [
        `ALTER TABLE ${q(e.from_table, d)} ADD CONSTRAINT ${q(name, d)} FOREIGN KEY (${q(e.from_column, d)}) ` +
          `REFERENCES ${q(e.to_table, d)} (${q(e.to_column, d)});`,
      ];
    }
    case "fk_removed": {
      const e = change.edge;
      if (!e) return [];
      const name = e.name || `FK_${e.from_table}_${e.to_table}`;
      return [
        d === "mysql"
          ? `ALTER TABLE ${q(e.from_table, d)} DROP FOREIGN KEY ${q(name, d)};`
          : `ALTER TABLE ${q(e.from_table, d)} DROP CONSTRAINT ${q(name, d)};`,
      ];
    }
    case "comment_changed": {
      const c = change.comment;
      if (!c) return [];
      return [
        d === "mysql"
          ? `ALTER TABLE ${t} COMMENT = '${esc(c.to)}';`
          : `COMMENT ON TABLE ${t} IS '${esc(c.to)}';`,
      ];
    }
    default:
      return [];
  }
}

/** 一批改动 → 一段可执行的脚本（按表分组并加注释） */
export function changesToSql(
  changes: ModelChange[],
  d: Dialect,
  tables: GraphTable[],
): string {
  // 新建表必须排在最前面：后面加的外键 / 索引可能依赖刚建出来的表
  const creates = changes.filter((c) => c.kind === "table_added");
  const rest = changes.filter((c) => c.kind !== "table_added");
  const lines: string[] = [];
  if (creates.length > 0) {
    lines.push("-- ===== 新建表 =====");
    for (const c of creates) {
      const table = tables.find((t) => t.name.toLowerCase() === c.table.toLowerCase());
      lines.push(...changeToSql(c, d, table));
      lines.push("");
    }
  }

  const byTable = new Map<string, ModelChange[]>();
  for (const c of rest) {
    const list = byTable.get(c.table);
    if (list) list.push(c);
    else byTable.set(c.table, [c]);
  }
  for (const [tableName, list] of byTable) {
    lines.push(`-- ===== ${tableName} =====`);
    const table = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
    for (const c of list) {
      lines.push(...changeToSql(c, d, table));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
