import type { GraphEdge, GraphTable, SchemaGraph } from "./types";

/**
 * 模型里的增删改（只动内存/文件里的模型，不碰数据库）。
 *
 * 关键在于**改名的连带处理**：表改名、列改名之后，别的表指向它/它的列的外键
 * 不能指丢——这里按「列在表里的位置」推断列改名映射（编辑器里是按顺序改的）。
 */

function cloneColumnsMapping(oldTable: GraphTable | undefined, table: GraphTable): Map<string, string> {
  const map = new Map<string, string>();
  oldTable?.columns.forEach((oldCol, i) => {
    const newCol = table.columns[i];
    if (newCol && oldCol.name.toLowerCase() !== newCol.name.toLowerCase()) {
      map.set(oldCol.name.toLowerCase(), newCol.name);
    }
  });
  return map;
}

/** 保存一张表：`oldName = null` 表示新建 */
export function applyTableEdit(
  graph: SchemaGraph,
  oldName: string | null,
  table: GraphTable,
  tableEdges: GraphEdge[],
): SchemaGraph {
  const oldTable = oldName ? graph.tables.find((t) => t.name === oldName) : undefined;
  const renamed = !!oldName && oldName !== table.name;
  const columnRenames = cloneColumnsMapping(oldTable, table);

  const tables = oldName
    ? graph.tables.map((t) => (t.name === oldName ? table : t))
    : [...graph.tables, table];

  const edges = graph.edges
    // 这张表的出边整组替换（弹窗里编的就是它）
    .filter((e) => e.from_table !== (oldName ?? table.name))
    .map((e) => {
      if (e.to_table !== (oldName ?? table.name)) return e;
      const mapped = columnRenames.get(e.to_column.toLowerCase());
      return {
        ...e,
        to_table: renamed ? table.name : e.to_table,
        to_column: mapped ?? e.to_column,
      };
    })
    .concat(tableEdges);

  // 外键列标记重算（只按真实外键，不做推断）
  const fkColumns = new Set(
    edges.filter((e) => e.from_table === table.name).map((e) => e.from_column),
  );
  const nextTable: GraphTable = {
    ...table,
    columns: table.columns.map((c) => ({ ...c, foreign_key: fkColumns.has(c.name) })),
  };

  return {
    tables: tables.map((t) => (t.name === table.name ? nextTable : t)),
    edges,
  };
}

/** 从模型里删掉一张表（连同与它相关的所有外键） */
export function removeTable(graph: SchemaGraph, name: string): SchemaGraph {
  return {
    tables: graph.tables.filter((t) => t.name !== name),
    edges: graph.edges.filter((e) => e.from_table !== name && e.to_table !== name),
  };
}
