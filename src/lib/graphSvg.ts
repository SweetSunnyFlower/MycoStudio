import type { Node } from "@xyflow/react";
import type { SchemaGraph, GraphTable } from "./types";
import { NODE_WIDTH, NOTE_H, ROW_H, annoText, nodeHeightOf } from "./graphLayout";

/**
 * 把 ER 图直接画成 SVG（不克隆 DOM）。
 *
 * 之前用 html-to-image 导出：它会把整个画布 DOM 克隆一遍、逐个元素 getComputedStyle，
 * 几百张表时主线程直接卡死。这里改成按布局数据自己拼 SVG 字符串：
 * 几百张表也就是几毫秒的字符串拼接，PNG 只是把这串 SVG 光栅化一次。
 */

const HEADER_H = 34;
const INDEX_ROW_H = 14;
const PAD = 24;
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** PNG 光栅化的像素上限（超过就自动降倍率，避免一张图几个亿像素） */
const MAX_PIXELS = 16_000_000;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 等宽字体下的粗略字宽，用来截断过长文本（导图不需要像素级精确） */
const charW = (size: number) => size * 0.6;

function clip(text: string, size: number, maxWidth: number): string {
  const max = Math.max(1, Math.floor(maxWidth / charW(size)));
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function indexRows(t: GraphTable): number {
  return (t.indexes ?? []).filter((i) => !i.primary).length;
}

export interface GraphSvgResult {
  svg: string;
  width: number;
  height: number;
}

export interface GraphSvgOptions {
  /** 只导出这块区域（当前视图）；不传就导出整个模型 */
  crop?: { x: number; y: number; width: number; height: number } | null;
  /** 图里高亮这些表 */
  hits?: string[];
}

/** 生成 SVG 字符串；节点位置直接用画布上的布局结果 */
export function graphToSvg(
  graph: SchemaGraph,
  nodes: Node[],
  options: GraphSvgOptions = {},
): GraphSvgResult {
  const pos = new Map<string, { x: number; y: number }>();
  /** 搜索命中时画布只显示部分字段，导出要跟画布一致 */
  const visible = new Map<string, string[] | undefined>();
  let showComments = false;
  for (const n of nodes) {
    pos.set(n.id, n.position);
    const data = n.data as { visibleColumns?: string[]; showComments?: boolean } | undefined;
    if (data?.visibleColumns) visible.set(n.id, data.visibleColumns);
    if (data?.showComments) showComments = true;
  }
  const shownColumns = (t: GraphTable) => {
    const v = visible.get(t.name);
    return v ? t.columns.filter((c) => v.includes(c.name)) : t.columns;
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of graph.tables) {
    const p = pos.get(t.name);
    if (!p) continue;
    const h = nodeHeightOf(t, visible.get(t.name), showComments);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_WIDTH);
    maxY = Math.max(maxY, p.y + h);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 100;
    maxY = 100;
  }
  const box = options.crop ?? {
    x: minX - PAD,
    y: minY - PAD,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  };
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  const hits = new Set(options.hits ?? []);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="${box.x} ${box.y} ${width} ${height}" font-family="${FONT}">`,
  );
  parts.push(`<rect x="${box.x}" y="${box.y}" width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" ` +
      `orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs>`,
  );

  // 先画连线（压在下层），再画表
  for (const e of graph.edges) {
    const from = pos.get(e.from_table);
    const to = pos.get(e.to_table);
    const fromTable = graph.tables.find((t) => t.name === e.from_table);
    const toTable = graph.tables.find((t) => t.name === e.to_table);
    if (!from || !to || !fromTable || !toTable) continue;
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + nodeHeightOf(fromTable, visible.get(fromTable.name), showComments) / 2;
    const x2 = to.x;
    const y2 = to.y + nodeHeightOf(toTable, visible.get(toTable.name), showComments) / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.4);
    const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    parts.push(`<path d="${path}" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow)"/>`);
    if (e.from_column) {
      const lx = (x1 + x2) / 2;
      const ly = (y1 + y2) / 2;
      const w = e.from_column.length * charW(10) + 8;
      parts.push(
        `<rect x="${lx - w / 2}" y="${ly - 7}" width="${w}" height="14" rx="4" fill="#f1f5f9" opacity="0.95"/>`,
      );
      parts.push(
        `<text x="${lx}" y="${ly + 3.5}" font-size="10" text-anchor="middle" fill="#475569">${esc(e.from_column)}</text>`,
      );
    }
  }

  for (const t of graph.tables) {
    const p = pos.get(t.name);
    if (!p) continue;
    const shown = shownColumns(t);
    const idxCount = indexRows(t);
    const h = nodeHeightOf(t, visible.get(t.name), showComments);
    const stroke = hits.has(t.name) ? "#0284c7" : "#e2e8f0";
    const strokeW = hits.has(t.name) ? 2 : 1;
    parts.push(
      `<g><rect x="${p.x}" y="${p.y}" width="${NODE_WIDTH}" height="${h}" rx="8" fill="#ffffff" ` +
        `stroke="${stroke}" stroke-width="${strokeW}"/>`,
    );
    // 表头
    parts.push(
      `<path d="M ${p.x} ${p.y + HEADER_H} L ${p.x} ${p.y + 8} Q ${p.x} ${p.y} ${p.x + 8} ${p.y} ` +
        `L ${p.x + NODE_WIDTH - 8} ${p.y} Q ${p.x + NODE_WIDTH} ${p.y} ${p.x + NODE_WIDTH} ${p.y + 8} ` +
        `L ${p.x + NODE_WIDTH} ${p.y + HEADER_H} Z" fill="#f8fafc"/>`,
    );
    parts.push(`<line x1="${p.x}" y1="${p.y + HEADER_H}" x2="${p.x + NODE_WIDTH}" y2="${p.y + HEADER_H}" stroke="#e2e8f0"/>`);
    parts.push(
      `<text x="${p.x + 8}" y="${p.y + 21}" font-size="12" font-weight="600" fill="#0f172a">${esc(
        clip(t.name, 12, NODE_WIDTH - 60),
      )}</text>`,
    );
    parts.push(
      `<text x="${p.x + NODE_WIDTH - 8}" y="${p.y + 21}" font-size="10" text-anchor="end" fill="#94a3b8">${t.columns.length}</text>`,
    );
    // 表注释 / 逻辑名
    let noteY = p.y + HEADER_H;
    const tableNote = showComments ? `${annoText(t)}` : "";
    if (tableNote) {
      parts.push(
        `<text x="${p.x + 22}" y="${p.y + 34}" font-size="10" fill="#94a3b8">${esc(
          clip(tableNote, 10, NODE_WIDTH - 32),
        )}</text>`,
      );
      noteY += NOTE_H;
    }
    // 字段
    let y = noteY + 4;
    for (const c of shown) {
      if (c.primary_key || c.foreign_key) {
        const color = c.primary_key ? "#f59e0b" : "#0ea5e9";
        parts.push(`<circle cx="${p.x + 12}" cy="${y + ROW_H / 2}" r="3" fill="${color}"/>`);
      }
      const typeW = Math.min(90, c.raw_type.length * charW(10));
      parts.push(
        `<text x="${p.x + 22}" y="${y + 15}" font-size="11" fill="#0f172a">${esc(
          clip(c.name, 11, NODE_WIDTH - 30 - typeW),
        )}</text>`,
      );
      parts.push(
        `<text x="${p.x + NODE_WIDTH - 8}" y="${y + 15}" font-size="10" text-anchor="end" fill="#94a3b8">${esc(
          clip(c.raw_type, 10, 100),
        )}</text>`,
      );
      const note = showComments ? annoText(c) : "";
      if (note) {
        parts.push(
          `<text x="${p.x + 22}" y="${y + ROW_H + 9}" font-size="10" fill="#94a3b8">${esc(
            clip(note, 10, NODE_WIDTH - 32),
          )}</text>`,
        );
      }
      y += ROW_H + (note ? NOTE_H : 0);
    }
    // 索引
    const indexes = (t.indexes ?? []).filter((i) => !i.primary);
    if (idxCount > 0) {
      const top = y;
      parts.push(
        `<line x1="${p.x}" y1="${top}" x2="${p.x + NODE_WIDTH}" y2="${top}" stroke="#e2e8f0"/>`,
      );
      indexes.slice(0, 4).forEach((ix, i) => {
        const y = top + 12 + i * INDEX_ROW_H;
        parts.push(
          `<text x="${p.x + 10}" y="${y}" font-size="10" fill="#64748b">${esc(
            clip(`${ix.name}${ix.unique ? " · 唯一" : ""}`, 10, NODE_WIDTH - 20),
          )}</text>`,
        );
      });
    }
    parts.push("</g>");
  }
  parts.push("</svg>");
  return { svg: parts.join("\n"), width, height };
}

/** SVG → PNG 字节（走浏览器光栅化，异步、不阻塞太久；超大图自动降倍率） */
export async function svgToPngBytes(
  svg: string,
  width: number,
  height: number,
  wantedScale = 2,
): Promise<number[]> {
  const budget = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
  const scale = Math.max(0.2, Math.min(wantedScale, budget));
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG 光栅化失败"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("拿不到 canvas 上下文");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("生成 PNG 失败");
    return Array.from(new Uint8Array(await png.arrayBuffer()));
  } finally {
    URL.revokeObjectURL(url);
  }
}
