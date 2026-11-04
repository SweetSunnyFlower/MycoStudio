import dagre from "dagre";
import type { Node } from "@xyflow/react";
import type { GraphTable, SchemaGraph } from "./types";

/** 表节点宽度（布局和导出都用它算尺寸） */
export const NODE_WIDTH = 260;
export const HEADER_H = 34;
export const ROW_H = 22;
/** 注释 / 逻辑名那一行的高度 */
export const NOTE_H = 13;
/** 块与块之间的行列间距 */
const GAP_X = 28;
const GAP_Y = 28;

export interface LayoutOptions {
  hitTables?: string[];
  visibleColumns?: Record<string, string[]>;
  /** 是否显示注释 + 逻辑名（会改变节点高度，所以布局要知道） */
  showComments?: boolean;
  /** 与另一个模型对比的结果：表名（小写）→ 状态，用来给节点上色 */
  tableStatus?: Record<string, "added" | "removed" | "changed" | "same">;
  /** 画布尺寸：用来决定摆放的目标宽度（不给就按正方形估） */
  width?: number;
  height?: number;
}

/** 表/字段的说明文字：逻辑名与注释都有就并起来，重复只留一个 */
export function annoText(x: { logical_name?: string; comment?: string }): string {
  const logical = (x.logical_name ?? "").trim();
  const comment = (x.comment ?? "").trim();
  if (logical && comment && logical !== comment) return `${logical} · ${comment}`;
  return logical || comment;
}

/** 表节点高度跟着字段数（和索引块）走 */
export function nodeHeightOf(t: GraphTable, visibleColumns?: string[], showComments = false): number {
  const shown = visibleColumns ? t.columns.filter((c) => visibleColumns.includes(c.name)) : t.columns;
  const header = HEADER_H + (showComments && annoText(t) ? NOTE_H : 0);
  const rows = shown.reduce(
    (sum, c) => sum + ROW_H + (showComments && annoText(c) ? NOTE_H : 0),
    0,
  );
  const extraIndexes = (t.indexes ?? []).filter((i) => !i.primary).length;
  const indexBlock = extraIndexes > 0 ? 18 + Math.min(extraIndexes, 4) * 14 : 0;
  return header + rows + 10 + indexBlock;
}

/**
 * 摆放用的目标宽度：让整张图跟画布**大致同比例**，
 * 而不是永远横着长（一条长龙）或竖着长（一根长条）。
 */
export function targetBlockWidth(
  totalArea: number,
  options: { width?: number; height?: number } = {},
): number {
  const aspect =
    options.width && options.height && options.height > 0 ? options.width / options.height : 1;
  return Math.sqrt(Math.max(1, totalArea) * aspect);
}

/**
 * ER 图布局：
 * 1. 先按「真实外键」把表分成若干**连通块**（孤立表自己就是一块）；
 * 2. 每块内部用 dagre 分层（左→右），关系看得清；
 * 3. 再把这些块按高度从大到小**货架式摆放**，目标宽度按画布宽高比估。
 *
 * 为什么要这么绕：直接让 dagre 排整张图时，几百张没有外键的表会排成一条无限长的横线；
 * 而一堆「两两成对」的小链条又会被 dagre 竖着堆成一根长条（实测 397 表能拉到 3 万像素高）。
 */
export function layoutGraph(graph: SchemaGraph, options: LayoutOptions = {}): Node[] {
  const hits = new Set(options.hitTables ?? []);
  const heightOf = (t: GraphTable) =>
    nodeHeightOf(t, options.visibleColumns?.[t.name], options.showComments);

  // ---- 1) 并查集找连通块 ----
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const known = new Set(graph.tables.map((t) => t.name));
  for (const t of graph.tables) parent.set(t.name, t.name);
  for (const e of graph.edges) {
    if (known.has(e.from_table) && known.has(e.to_table)) union(e.from_table, e.to_table);
  }
  const groups = new Map<string, GraphTable[]>();
  for (const t of graph.tables) {
    const root = find(t.name);
    const list = groups.get(root);
    if (list) list.push(t);
    else groups.set(root, [t]);
  }

  // ---- 2) 每块内部布局（相对坐标，左上角归零）----
  interface Block {
    width: number;
    height: number;
    items: { table: GraphTable; x: number; y: number }[];
  }
  const blocks: Block[] = [];
  // 单个连通块如果被 dagre 拉得太长（超长链、某个 rank 挤了几百张表），
  // 就放弃它内部的分层，退回「一张表一个块」的网格摆放——否则画布会被拉到几万像素
  const blockCap = Math.max(6000, (options.width ?? 1400) * 3);
  for (const tables of groups.values()) {
    if (tables.length === 1) {
      const t = tables[0];
      blocks.push({ width: NODE_WIDTH, height: heightOf(t), items: [{ table: t, x: 0, y: 0 }] });
      continue;
    }
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 90, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    const inBlock = new Set(tables.map((t) => t.name));
    for (const t of tables) g.setNode(t.name, { width: NODE_WIDTH, height: heightOf(t) });
    for (const e of graph.edges) {
      if (inBlock.has(e.from_table) && inBlock.has(e.to_table)) g.setEdge(e.from_table, e.to_table);
    }
    dagre.layout(g);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const items = tables.map((t) => {
      const pos = g.node(t.name);
      const x = pos.x - NODE_WIDTH / 2;
      const y = pos.y - pos.height / 2;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_WIDTH);
      maxY = Math.max(maxY, y + pos.height);
      return { table: t, x, y };
    });
    const width = maxX - minX;
    const height = maxY - minY;
    if (width > blockCap || height > blockCap) {
      for (const t of tables) {
        blocks.push({ width: NODE_WIDTH, height: heightOf(t), items: [{ table: t, x: 0, y: 0 }] });
      }
      continue;
    }
    blocks.push({
      width,
      height,
      items: items.map((it) => ({ ...it, x: it.x - minX, y: it.y - minY })),
    });
  }

  // ---- 3) 货架式摆放：高的块先放，一行放不下就换行 ----
  const totalArea = blocks.reduce((sum, b) => sum + (b.width + GAP_X) * (b.height + GAP_Y), 0);
  const widest = blocks.reduce((m, b) => Math.max(m, b.width + GAP_X), NODE_WIDTH + GAP_X);
  const target = Math.max(widest, targetBlockWidth(totalArea, options));
  const sorted = [...blocks].sort((a, b) => b.height - a.height || b.width - a.width);

  const out: Node[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const block of sorted) {
    if (cursorX > 0 && cursorX + block.width > target) {
      cursorX = 0;
      cursorY += rowHeight + GAP_Y;
      rowHeight = 0;
    }
    for (const item of block.items) {
      out.push({
        id: item.table.name,
        type: "table",
        position: { x: cursorX + item.x, y: cursorY + item.y },
        data: {
          table: item.table,
          hit: hits.has(item.table.name),
          visibleColumns: options.visibleColumns?.[item.table.name],
          showComments: options.showComments,
          status: options.tableStatus?.[item.table.name.toLowerCase()],
        },
      });
    }
    cursorX += block.width + GAP_X;
    rowHeight = Math.max(rowHeight, block.height);
  }
  return out;
}

/** 只按字段数算高度（导出、测试用） */
export function tableHeight(t: GraphTable, visibleColumns?: string[]): number {
  return nodeHeightOf(t, visibleColumns);
}
