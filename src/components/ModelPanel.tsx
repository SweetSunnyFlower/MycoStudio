import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Edge, type Node } from "@xyflow/react";
import { save } from "@tauri-apps/plugin-dialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  Download,
  GitCompare,
  Loader2,
  Maximize2,
  RefreshCw,
  Search,
  StickyNote,
  Table2,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { graphToDbml, graphToMarkdown, graphToMermaid } from "@/lib/graphExport";
import { graphToPdm } from "@/lib/pdmExport";
import { ensureExtension, exportGraphImage } from "@/lib/graphImage";
import { diffModels, type TableStatus } from "@/lib/modelDiff";
import { diffScopeKey } from "@/lib/diffNotes";
import { ModelDiffPanel } from "./ModelDiffPanel";
import { ErCanvas, graphEdges, useCanvasSize } from "./ErCanvas";
import { NODE_WIDTH, layoutGraph } from "@/lib/graphLayout";
import { useAppStore } from "@/store/app";
import type { SchemaGraph } from "@/lib/types";

interface Props {
  database: string;
  /** 双击表节点 → 打开这张表的表标签页 */
  onOpenTable: (db: string, table: string) => void;
  /** 只有这个标签可见时才去读结构（避免每次打开工作台都拉一遍整库） */
  active?: boolean;
}

function Canvas({ database, onOpenTable, active = true }: Props) {
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  /** 是否在图上显示注释 / 逻辑名（默认开：中文名与备注是看模型的主要信息） */
  const [showComments, setShowComments] = useState(true);
  /** 与 PDM 对比的结果：用来在画布上给表上色（绿=新增/红=库里多出来/黄=有差异） */
  const [compareTarget, setCompareTarget] = useState<{ graph: SchemaGraph; label: string } | null>(null);
  const [statusByTable, setStatusByTable] = useState<Record<string, TableStatus>>({});
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const canvasSize = useCanvasSize(wrapper);
  const loadedKey = useRef<string | null>(null);
  const { fitView, setCenter, getViewport } = useReactFlow();
  const activeId = useAppStore((s) => s.activeId);
  const activeFlavor = useAppStore((s) => s.connections.find((c) => c.id === s.activeId)?.flavor);

  const load = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.schemaGraph(activeId, database);
      loadedKey.current = `${activeId}:${database}`;
      setGraph(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [activeId, database]);

  useEffect(() => {
    if (!active) return;
    const key = `${activeId}:${database}`;
    if (loadedKey.current === key) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, database, activeId]);

  // 结构 / 画布尺寸变了就重排一次（瀑布流分几列跟画布宽高比有关）
  useEffect(() => {
    if (!graph) return;
    setNodes(
      layoutGraph(graph, {
        width: canvasSize.width,
        height: canvasSize.height,
        showComments,
        tableStatus: statusByTable,
      }),
    );
    setEdges(graphEdges(graph));
    window.setTimeout(() => void fitView({ padding: 0.15, duration: 200 }), 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, canvasSize.width, canvasSize.height, showComments, statusByTable]);

  /** 选一个 PDM 文件，和当前库对比（库里是现状，PDM 是期望） */
  async function compareWithPdm() {
    if (!graph) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "PowerDesigner", extensions: ["pdm", "xml"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const file = await api.readPdm(picked);
      const diff = diffModels(graph, file.graph);
      const status: Record<string, TableStatus> = {};
      for (const t of diff.tables) if (t.status !== "same") status[t.name.toLowerCase()] = t.status;
      setStatusByTable(status);
      setCompareTarget({ graph: file.graph, label: file.file_name });
      // 前 8 秒用 toast 汇总一下，详细差异在弹窗里看
      toast.info(
        `与 ${file.file_name} 对比：新建 ${diff.summary.added} 张表 · 库里多出 ${diff.summary.removed} 张 · 有差异 ${diff.summary.changed} 张`,
        { duration: 8000 },
      );
    } catch (e) {
      toast.error("读取 PDM 失败", { description: String(e) });
    }
  }

  /** 搜索定位：找到就居中并选中那张表 */
  function locate() {
    const kw = keyword.trim().toLowerCase();
    if (!kw || !graph) return;
    const hit = graph.tables.find((t) => t.name.toLowerCase().includes(kw));
    if (!hit) {
      toast.info(`没有匹配的表：${keyword}`);
      return;
    }
    const node = nodes.find((n) => n.id === hit.name);
    if (node) {
      void setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + 80, { zoom: 1, duration: 300 });
    }
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === hit.name })));
  }

  async function exportImage(kind: "png" | "svg") {
    if (!graph) return;
    await exportGraphImage({ graph, nodes, kind, baseName: `${database}-model` });
  }

  /** 只导出当前视图（大模型时更快、图也更小） */
  async function exportViewport(kind: "png" | "svg") {
    if (!graph) return;
    const el = wrapper.current;
    const { x, y, zoom } = getViewport();
    const crop = el
      ? { x: -x / zoom, y: -y / zoom, width: el.clientWidth / zoom, height: el.clientHeight / zoom }
      : null;
    await exportGraphImage({ graph, nodes, kind, baseName: `${database}-view`, crop });
  }

  /** 导出 PowerDesigner .pdm（可以用 PowerDesigner 打开，也能再拖回本应用） */
  async function exportPdm() {
    if (!graph) return;
    try {
      const model = `${database}_physical`;
      const picked = await save({
        defaultPath: `${database}.pdm`,
        filters: [{ name: "PowerDesigner", extensions: ["pdm"] }],
      });
      if (!picked) return;
      await api.writeTextFile(ensureExtension(picked, "pdm"), graphToPdm(graph, model));
      toast.success("已导出 PDM");
    } catch (e) {
      toast.error("导出 PDM 失败", { description: String(e) });
    }
  }

  async function exportText(kind: "dbml" | "mermaid" | "md" | "ddl") {
    if (!graph) return;
    const ext = kind === "mermaid" ? "mmd" : kind === "md" ? "md" : kind === "dbml" ? "dbml" : "sql";
    try {
      let content: string;
      if (kind === "dbml") content = graphToDbml(graph);
      else if (kind === "mermaid") content = graphToMermaid(graph);
      else if (kind === "md") content = graphToMarkdown(graph);
      else {
        if (!activeId) return;
        const parts: string[] = [];
        for (const t of graph.tables) {
          const ddl = await api.tableDdl(activeId, database, t.name);
          parts.push(ddl.trim().replace(/;?$/, ";"));
        }
        content = parts.join("\n\n");
      }
      const picked = await save({
        defaultPath: `${database}-model.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!picked) return;
      const path = ensureExtension(picked, ext);
      await api.writeTextFile(path, content);
      toast.success("已导出");
    } catch (e) {
      toast.error("导出失败", { description: String(e) });
    }
  }

  const counts = { tables: graph?.tables.length ?? 0, edges: graph?.edges.length ?? 0 };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <Table2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">数据模型</span>
        <span className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{database}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {counts.tables} 张表 · {counts.edges} 条外键
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div className="relative w-44">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-7 pl-7 text-xs"
              placeholder="定位表名"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && locate()}
            />
          </div>
          <Button size="xs" variant="ghost" title="重新布局" onClick={() => void load()}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
            重新布局
          </Button>
          <Button
            size="xs"
            variant={showComments ? "secondary" : "ghost"}
            title="在图上显示字段注释 / 逻辑名"
            onClick={() => setShowComments((v) => !v)}
          >
            <StickyNote className="size-3.5" /> 注释
          </Button>
          <Button size="xs" variant="outline" title="挑一个 PDM 设计与当前库对比，生成 ALTER 脚本" onClick={() => void compareWithPdm()}>
            <GitCompare className="size-3.5" /> 对比 PDM
          </Button>
          {compareTarget && (
            <Button size="xs" variant="ghost" title="清除对比结果" onClick={() => { setCompareTarget(null); setStatusByTable({}); }}>
              <X className="size-3.5" />
            </Button>
          )}
          <Button size="xs" variant="ghost" title="适应画布" onClick={() => void fitView({ padding: 0.15, duration: 200 })}>
            <Maximize2 className="size-3.5" />
          </Button>
          <Button size="xs" variant="ghost" title="刷新" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="outline">
                <Download className="size-3.5" /> 导出
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-max">
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportImage("png")}>
                导出 PNG · 整个模型
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportImage("svg")}>
                导出 SVG · 整个模型
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportViewport("png")}>
                导出 PNG · 当前视图
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportViewport("svg")}>
                导出 SVG · 当前视图
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportPdm()}>
                导出 PDM（PowerDesigner）
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportText("ddl")}>
                导出 DDL · 所有表
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportText("dbml")}>
                导出 DbML
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportText("mermaid")}>
                导出 Mermaid erDiagram
              </DropdownMenuItem>
              <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportText("md")}>
                导出 Markdown 表清单
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {graph && graph.edges.length === 0 && counts.tables > 0 && (
        <div className="shrink-0 border-b bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          这个库里没有外键约束，所以只有表、没有连线（只画真实外键，不做推断）
        </div>
      )}
      {compareTarget && (
        <div className="flex shrink-0 items-center gap-3 border-b bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          <span>与 {compareTarget.label} 对比中</span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full border-2 border-emerald-500" /> 库里缺（要新建）
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full border-2 border-red-500" /> 库里多出来
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full border-2 border-amber-500" /> 有差异
          </span>
        </div>
      )}

      <div ref={wrapper} className="relative min-h-0 flex-1">
        {loading && !graph ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 正在读取库结构…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">{error}</div>
        ) : graph && graph.tables.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            这个库里还没有表
          </div>
        ) : (
          <ErCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange as never}
            onEdgesChange={onEdgesChange as never}
            onNodeDoubleClick={(table) => onOpenTable(database, table)}
          />
        )}
      </div>

      {compareTarget && graph && (
        <ModelDiffPanel
          open
          onClose={() => {
            setCompareTarget(null);
            setStatusByTable({});
          }}
          base={graph}
          target={compareTarget.graph}
          baseLabel={`当前库 ${database}`}
          targetLabel={compareTarget.label}
          flavor={activeFlavor}
          // 落库的键和「执行到库」也要跟 PDM 侧一致：同一对模型共享一份确认状态
          scopeKey={diffScopeKey({
            connectionId: activeId,
            database,
            target: compareTarget.label,
          })}
          connectionId={activeId}
          database={database}
        />
      )}
    </div>
  );
}

export function ModelPanel(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
