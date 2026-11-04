import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { NODE_WIDTH, NOTE_H, ROW_H, annoText } from "@/lib/graphLayout";
import { KeyRound, Link2, ListTree, StickyNote, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PdmNoteContext, pdmNoteKey, type PdmNoteApi } from "@/lib/pdmNotes";
import type { GraphTable, SchemaGraph } from "@/lib/types";

import "@xyflow/react/dist/style.css";

/** 量一下画布大小（瀑布流分列要用），容器尺寸变化时更新 */
export function useCanvasSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface TableNodeData {
  table: GraphTable;
  /** 搜索命中时高亮 */
  hit?: boolean;
  /** 只显示这些列（搜索命中字段时用）；不传则全显示 */
  visibleColumns?: string[];
  /** 是否显示注释 / 逻辑名 */
  showComments?: boolean;
  /** 与另一个模型对比的结果（给节点描边）：added=库里缺 / removed=库里多 / changed=有差异 */
  status?: "added" | "removed" | "changed" | "same";
  [key: string]: unknown;
}

/** 表节点：表名 + 字段（主键钥匙 / 外键链接 + 类型），下面挂索引 */
function TableNode({ data }: NodeProps) {
  const { table, hit, visibleColumns, showComments, status } = data as TableNodeData;
  const noteApi = useContext(PdmNoteContext);
  const columns = useMemo(
    () => (visibleColumns ? table.columns.filter((c) => visibleColumns.includes(c.name)) : table.columns),
    [table.columns, visibleColumns],
  );
  const hidden = table.columns.length - columns.length;
  const extraIndexes = (table.indexes ?? []).filter((i) => !i.primary);
  const tableNote = showComments ? annoText(table) : "";
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        hit && "border-sky-500 ring-2 ring-sky-400/60",
        // 对比结果用描边区分（和搜索高亮可以叠加）
        status === "added" && "border-emerald-500 ring-2 ring-emerald-400/50",
        status === "removed" && "border-red-500 ring-2 ring-red-400/50",
        status === "changed" && "border-amber-500 ring-2 ring-amber-400/50",
      )}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !bg-muted-foreground" />
      <div className="border-b bg-muted/50 px-2.5 py-1.5" title={table.logical_name || table.comment}>
        <div className="flex items-center gap-1.5">
          <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs font-medium">{table.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {table.columns.length}
          </span>
        </div>
        {tableNote && (
          <div className="truncate pl-5 text-[10px] text-muted-foreground" title={tableNote}>
            {tableNote}
          </div>
        )}
      </div>
      <div className="py-0.5">
        {columns.map((c) => {
          const note = showComments ? annoText(c) : "";
          return (
            <div
              key={c.name}
              title={note || undefined}
              className="px-2.5"
              style={{ height: ROW_H + (note ? NOTE_H : 0) }}
            >
              <div className="flex items-center gap-1.5 text-[11px] leading-[22px]" style={{ height: ROW_H }}>
                <span className="flex size-3 shrink-0 items-center justify-center">
                  {c.primary_key ? (
                    <KeyRound className="size-3 text-amber-500" />
                  ) : c.foreign_key ? (
                    <Link2 className="size-3 text-sky-500" />
                  ) : null}
                </span>
                <span className="truncate font-mono">{c.name}</span>
                <span className="ml-auto shrink-0 truncate pl-2 font-mono text-[10px] text-muted-foreground">
                  {c.raw_type}
                </span>
                {noteApi && (
                  <button
                    type="button"
                    className="nodrag nopan -mr-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition hover:bg-muted hover:text-foreground"
                    title={noteApi.notes.has(pdmNoteKey(table.name, c.name)) ? "查看 / 编辑笔记" : "添加笔记"}
                    onClick={(e) => {
                      e.stopPropagation();
                      noteApi.onOpen(table.name, c.name, e.currentTarget.getBoundingClientRect());
                    }}
                  >
                    <StickyNote
                      className={cn(
                        "size-3",
                        noteApi.notes.has(pdmNoteKey(table.name, c.name)) && "text-sky-500",
                      )}
                    />
                  </button>
                )}
              </div>
              {note && (
                <div
                  className="truncate pl-[18px] text-[10px] leading-[13px] text-muted-foreground"
                  style={{ height: NOTE_H }}
                >
                  {note}
                </div>
              )}
            </div>
          );
        })}
        {hidden > 0 && (
          <div className="px-2.5 text-[10px] text-muted-foreground">… 还有 {hidden} 个字段</div>
        )}
      </div>
      {extraIndexes.length > 0 && (
        <div className="border-t bg-muted/20 px-2.5 py-1">
          {extraIndexes.slice(0, 4).map((ix) => (
            <div
              key={ix.name}
              className="flex items-center gap-1 truncate text-[10px] text-muted-foreground"
              title={`${ix.name} (${ix.columns.join(", ")})${ix.unique ? " · 唯一" : ""}`}
            >
              <ListTree className="size-2.5 shrink-0" />
              <span className="truncate font-mono">{ix.name}</span>
              {ix.unique && <span className="shrink-0">唯一</span>}
            </div>
          ))}
          {extraIndexes.length > 4 && (
            <div className="text-[10px] text-muted-foreground">… 还有 {extraIndexes.length - 4} 个索引</div>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!size-1.5 !bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { table: TableNode };

export function graphEdges(graph: SchemaGraph): Edge[] {
  return graph.edges.map((e, i) => ({
    id: `e${i}-${e.from_table}.${e.from_column}`,
    source: e.from_table,
    target: e.to_table,
    label: e.from_column,
    labelShowBg: true,
    labelBgPadding: [3, 1] as [number, number],
    labelBgStyle: { fill: "var(--color-muted)", fillOpacity: 0.9 },
    labelStyle: { fontSize: 10, fontFamily: "monospace" },
    style: { strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  }));
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (changes: never[]) => void;
  onEdgesChange: (changes: never[]) => void;
  onNodeDoubleClick?: (table: string) => void;
  /** 传了才会在字段后面显示笔记 icon（PDM 视图才传） */
  pdmNotes?: PdmNoteApi | null;
  className?: string;
}

/** 可复用的 ER 画布：数据库模型视图和 PDM Reader 共用 */
export function ErCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeDoubleClick,
  pdmNotes,
  className,
}: Props) {
  // 按住空格进入「平移模式」：此时直接移动鼠标就平移画布，不需要按左键。
  // 同时关掉节点拖动和画布拖拽，避免和鼠标跟随平移叠加。
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const { getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      // 避免空格滚动页面
      e.preventDefault();
      if (!e.repeat) setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    const reset = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);

  useEffect(() => {
    spaceHeldRef.current = spaceHeld;
    // 刚按下 / 松开时清掉上次位置，避免第一下跳一段
    if (!spaceHeld) lastPos.current = null;
  }, [spaceHeld]);

  // 空格按住时，鼠标在画布上移动就平移（不依赖按键拖动）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      if (!spaceHeldRef.current) return;
      if (lastPos.current) {
        const dx = e.clientX - lastPos.current.x;
        const dy = e.clientY - lastPos.current.y;
        if (dx !== 0 || dy !== 0) {
          const vp = getViewport();
          void setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom });
        }
      }
      lastPos.current = { x: e.clientX, y: e.clientY };
    };
    const onLeave = () => {
      lastPos.current = null;
    };
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [getViewport, setViewport]);

  return (
    <PdmNoteContext.Provider value={pdmNotes ?? null}>
      <div ref={wrapRef} className={cn("h-full w-full", spaceHeld && "cursor-grab")}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange as never}
        onEdgesChange={onEdgesChange as never}
        onNodeDoubleClick={(_, node) => onNodeDoubleClick?.(node.id)}
        nodesDraggable={!spaceHeld}
        panOnDrag={!spaceHeld}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className={cn(
          "bg-muted/10",
          spaceHeld && "[&_.react-flow__pane]:!cursor-grab [&_.react-flow__node]:!cursor-grab",
          className,
        )}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!h-24 !w-40" />
      </ReactFlow>
      </div>
    </PdmNoteContext.Provider>
  );
}
