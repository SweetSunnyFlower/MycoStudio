import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Edge, type Node } from "@xyflow/react";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  History,
  Loader2,
  Maximize2,
  Search,
  StickyNote,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { graphToDbml, graphToDdl, graphToMarkdown, graphToMermaid } from "@/lib/graphExport";
import { graphToPdm } from "@/lib/pdmExport";
import { ensureExtension, exportGraphImage } from "@/lib/graphImage";
import { diffScopeKey } from "@/lib/diffNotes";
import { applyTableEdit, removeTable } from "@/lib/modelEdit";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app";
import { ErCanvas, graphEdges, useCanvasSize } from "./ErCanvas";
import { PdmNoteEditor, type PdmNoteTarget } from "./PdmNoteEditor";
import { pdmNoteKey, type PdmNoteApi } from "@/lib/pdmNotes";
import { NODE_WIDTH, layoutGraph } from "@/lib/graphLayout";
import { ModelDiffPanel } from "./ModelDiffPanel";
import { ModelTableDialog } from "./ModelTableDialog";
import { CompareDbDialog } from "./CompareDbDialog";
import { GitCompare, Pencil, Plus, RotateCcw } from "lucide-react";
import type {
  DbFlavor,
  GraphEdge,
  GraphTable,
  PdmFile,
  PdmFileRecord,
  SchemaGraph,
} from "@/lib/types";

/** 一个关键字在某个 PDM 文件里命中的内容 */
interface Hits {
  tables: Set<string>;
  /** 表名 → 命中的字段名（表本身命中时为空，表示整表高亮） */
  columns: Record<string, string[]>;
}

/** 在整个文件里搜关键字：表名 / 字段名 / 表注释 / 字段注释 */
function searchFile(file: PdmFile, keyword: string): Hits | null {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return null;
  const hits: Hits = { tables: new Set(), columns: {} };
  for (const t of file.graph.tables) {
    const tableHit = t.name.toLowerCase().includes(kw) || (t.comment ?? "").toLowerCase().includes(kw);
    const cols: string[] = [];
    for (const c of t.columns) {
      if (c.name.toLowerCase().includes(kw) || (c.comment ?? "").toLowerCase().includes(kw)) {
        cols.push(c.name);
      }
    }
    if (tableHit) {
      hits.tables.add(t.name);
    } else if (cols.length > 0) {
      hits.tables.add(t.name);
      hits.columns[t.name] = cols;
    }
  }
  return hits.tables.size > 0 ? hits : null;
}

/** 搜索命中时画布只留「命中表 + 与它直接相连的表」（画布与导出共用同一套裁剪） */
function filterGraph(graph: SchemaGraph, hit: Hits): SchemaGraph {
  const keep = new Set<string>(hit.tables);
  for (const e of graph.edges) {
    if (keep.has(e.from_table)) keep.add(e.to_table);
    if (keep.has(e.to_table)) keep.add(e.from_table);
  }
  return {
    tables: graph.tables.filter((t) => keep.has(t.name)),
    edges: graph.edges.filter((e) => keep.has(e.from_table) && keep.has(e.to_table)),
  };
}

/** 本地 SQLite 里存「PDM 会话」的 key：打开过哪些文件 + 当前标签 */
const PDM_SESSION_KEY = "pdm.session";

function PdmWorkspace({ onBack }: { onBack: () => void }) {
  const [files, setFiles] = useState<PdmFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  /** 字段笔记：当前文件已有的（key → markdown）+ 正在编辑的目标 */
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [noteTarget, setNoteTarget] = useState<PdmNoteTarget | null>(null);
  /** 最近打开过的 PDM 文件（来自本地库，关掉标签也能从这里重开） */
  const [recent, setRecent] = useState<PdmFileRecord[]>([]);
  /** 是否在图上显示注释 / 逻辑名（PDM 里中文名就是逻辑名 a:Name，默认开） */
  const [showComments, setShowComments] = useState(true);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  /** 正向建模：编辑开关 + 正在编辑的表 + 原始模型（用于撤销）*/
  const [editing, setEditing] = useState(false);
  const [editTarget, setEditTarget] = useState<GraphTable | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const originals = useRef<Map<string, SchemaGraph>>(new Map());
  /** 从 PDM 侧比数据库 */
  const [compareDbOpen, setCompareDbOpen] = useState(false);
  const [compared, setCompared] = useState<{
    graph: SchemaGraph;
    label: string;
    connectionId: string;
    database: string;
    flavor: DbFlavor;
  } | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const canvasSize = useCanvasSize(wrapper);
  const tabStrip = useRef<HTMLDivElement | null>(null);
  const { fitView, setCenter, getViewport } = useReactFlow();

  const activeFile = files.find((f) => f.path === active) ?? files[0] ?? null;

  // 恢复上次打开的文件：重启 / 离开页面再回来都不用重新一个个打开
  const sessionRestored = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // 只有真正读到会话（或确认没有会话）才允许回写，
    // 读库失败时不要用空列表把已有会话覆盖掉
    let loadedOk = false;
    void (async () => {
      try {
        const raw = await api.getAppSetting(PDM_SESSION_KEY);
        if (cancelled) return;
        // 没有会话也算「读成功」：允许后续把新打开的写回去
        if (!raw) {
          loadedOk = true;
          return;
        }
        const data = JSON.parse(raw) as { paths?: unknown; active?: unknown };
        loadedOk = true;
        const paths = Array.isArray(data.paths)
          ? data.paths.filter((p): p is string => typeof p === "string")
          : [];
        const loaded: PdmFile[] = [];
        const missing: string[] = [];
        const seen = new Set<string>();
        for (const path of paths) {
          if (seen.has(path)) continue;
          seen.add(path);
          try {
            loaded.push(await api.readPdm(path));
          } catch {
            missing.push(path);
          }
        }
        if (cancelled) return;
        if (loaded.length > 0) {
          setFiles(loaded);
          const wanted = typeof data.active === "string" ? data.active : null;
          setActive(loaded.some((f) => f.path === wanted) ? wanted : loaded[0].path);
        }
        if (missing.length > 0) {
          toast.info(`有 ${missing.length} 个 PDM 文件已找不到，已从会话里移除`, {
            description: missing.map((p) => p.split("/").pop() ?? p).join("、"),
            duration: 9000,
          });
        }
      } catch {
        // 会话读不出来就当没有，不影响手动打开
      } finally {
        if (!cancelled && loadedOk) sessionRestored.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开 / 关闭文件、切换标签时写回会话（等恢复完成，避免用空列表覆盖）
  useEffect(() => {
    if (!sessionRestored.current) return;
    const data = JSON.stringify({
      paths: files.map((f) => f.path),
      active: activeFile?.path ?? null,
    });
    void api.setAppSetting(PDM_SESSION_KEY, data).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, active]);

  // 当前文件的字段笔记（切标签时重新拉）
  useEffect(() => {
    const id = activeFile?.id;
    if (!id) {
      setNotes(new Map());
      return;
    }
    let cancelled = false;
    void api
      .listPdmNotes(id)
      .then((list) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const n of list) map.set(pdmNoteKey(n.table, n.column), n.content);
        setNotes(map);
      })
      .catch((e) => {
        if (!cancelled) toast.error(`读取字段笔记失败：${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFile?.id]);

  // 切文件时关掉笔记浮层（按 key 卸载会触发一次自动保存）
  useEffect(() => {
    setNoteTarget(null);
  }, [activeFile?.id]);

  async function saveNote(table: string, column: string, markdown: string) {
    if (!activeFile) return;
    const key = pdmNoteKey(table, column);
    try {
      await api.savePdmNote(activeFile.id, activeFile.model_name, table, column, markdown);
      setNotes((prev) => {
        const next = new Map(prev);
        if (markdown.trim()) next.set(key, markdown);
        else next.delete(key);
        return next;
      });
    } catch (e) {
      toast.error(`笔记保存失败：${String(e)}`);
    }
  }

  const noteApi = useMemo<PdmNoteApi | null>(
    () =>
      activeFile
        ? {
            notes,
            onOpen: (table, column, anchor) => setNoteTarget({ table, column, anchor }),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeFile?.id, notes],
  );
  // 传给编辑弹窗的数组要 memo 住：每次渲染都新建数组会让弹窗里的表单被重置
  const editOtherTables = useMemo(
    () => (activeFile?.graph.tables ?? []).filter((t) => t.name !== editTarget?.name),
    [activeFile, editTarget],
  );
  const editEdges = useMemo(
    () => (activeFile?.graph.edges ?? []).filter((e) => e.from_table === editTarget?.name),
    [activeFile, editTarget],
  );

  /** 每个文件的命中情况（关键字为空时全 null） */
  const hits = useMemo(() => {
    const map = new Map<string, Hits | null>();
    for (const f of files) map.set(f.path, searchFile(f, keyword));
    return map;
  }, [files, keyword]);
  const searching = keyword.trim().length > 0;
  /** 搜索时只展示命中的文件 */
  const visibleFiles = searching ? files.filter((f) => hits.get(f.path)) : files;

  // 搜索时当前文件没命中、但有别的文件命中 → 自动切到第一个命中的文件，
  // 免得用户看到空画布还得自己去点那个闪动的标签
  useEffect(() => {
    if (!searching) return;
    const first = visibleFiles[0];
    if (!first) return;
    if (!activeFile || !hits.get(activeFile.path)) setActive(first.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, keyword, files, activeFile?.path]);

  /** 画布：搜索时只画命中的表 + 与它们直接相连的表，并把命中表高亮 */
  useEffect(() => {
    if (!activeFile) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const hit = searching ? hits.get(activeFile.path) ?? null : null;
    if (searching && !hit) {
      setNodes([]);
      setEdges([]);
      return;
    }
    let graph = activeFile.graph;
    let visibleColumns: Record<string, string[]> | undefined;
    if (hit) {
      graph = filterGraph(activeFile.graph, hit);
      // 字段命中的表只展开命中的字段（表名命中则整表展开）
      const narrowed: Record<string, string[]> = {};
      for (const [table, cols] of Object.entries(hit.columns)) {
        const row = activeFile.graph.tables.find((t) => t.name === table);
        if (!row) continue;
        // 命中字段加上主键/外键，关系看得清
        const keepCols = new Set(cols);
        for (const c of row.columns) if (c.primary_key || c.foreign_key) keepCols.add(c.name);
        narrowed[table] = row.columns.filter((c) => keepCols.has(c.name)).map((c) => c.name);
      }
      visibleColumns = Object.keys(narrowed).length > 0 ? narrowed : undefined;
    }
    setNodes(
      layoutGraph(graph, {
        hitTables: hit ? [...hit.tables] : [],
        visibleColumns,
        width: canvasSize.width,
        height: canvasSize.height,
        showComments,
      }),
    );
    setEdges(graphEdges(graph));
    window.setTimeout(() => void fitView({ padding: 0.15, duration: 200 }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, keyword, canvasSize.width, canvasSize.height, showComments]);

  async function loadRecent() {
    try {
      setRecent(await api.listPdmFiles());
    } catch {
      // 最近列表拿不到不影响手动打开
    }
  }

  useEffect(() => {
    void loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 按路径打开（文件选择器和「最近打开」共用），已经在标签里的直接切过去 */
  async function openPaths(paths: string[]) {
    if (paths.length === 0) return;
    setLoading(true);
    const next: PdmFile[] = [];
    for (const path of paths) {
      const opened = files.find((f) => f.path === path);
      if (opened) {
        setActive(opened.path);
        continue;
      }
      try {
        next.push(await api.readPdm(path));
      } catch (e) {
        toast.error(`打开失败：${path.split("/").pop()}`, { description: String(e), duration: 9000 });
      }
    }
    if (next.length > 0) {
      setFiles((prev) => [...prev, ...next]);
      setActive(next[0].path);
    }
    setLoading(false);
    void loadRecent();
  }

  async function openFiles() {
    const picked = await openDialog({ multiple: true, filters: [{ name: "PowerDesigner", extensions: ["pdm", "xml"] }] });
    const paths = typeof picked === "string" ? [picked] : (picked ?? []);
    await openPaths(paths);
  }

  function closeFile(path: string) {
    const next = files.filter((f) => f.path !== path);
    setFiles(next);
    originals.current.delete(path);
    setDirty((prev) => {
      const n = new Set(prev);
      n.delete(path);
      return n;
    });
    if (active === path) setActive(next[0]?.path ?? null);
  }

  /** 把改后的模型写回文件；同时记住原始版本用于「撤销全部修改」 */
  function updateActiveGraph(next: SchemaGraph) {
    if (!activeFile) return;
    const path = activeFile.path;
    if (!originals.current.has(path)) {
      originals.current.set(path, JSON.parse(JSON.stringify(activeFile.graph)) as SchemaGraph);
    }
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, graph: next } : f)));
    setDirty((prev) => new Set(prev).add(path));
  }

  /** 保存一张表：改名 / 改列的连带处理都在 modelEdit 里（可单测） */
  function saveTable(oldName: string | null, table: GraphTable, tableEdges: GraphEdge[]) {
    if (!activeFile) return;
    updateActiveGraph(applyTableEdit(activeFile.graph, oldName, table, tableEdges));
    setEditOpen(false);
    setEditTarget(null);
  }

  function deleteTable(name: string) {
    if (!activeFile) return;
    updateActiveGraph(removeTable(activeFile.graph, name));
    setEditOpen(false);
    setEditTarget(null);
  }

  /** 撤销这个文件上的全部模型改动 */
  function undoAll() {
    if (!activeFile) return;
    const original = originals.current.get(activeFile.path);
    if (!original) return;
    const path = activeFile.path;
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, graph: original } : f)));
    setDirty((prev) => {
      const n = new Set(prev);
      n.delete(path);
      return n;
    });
    toast.info("已撤销本文件的全部模型改动");
  }

  function scrollTabs(dir: -1 | 1) {
    tabStrip.current?.scrollBy({ left: dir * 240, behavior: "smooth" });
  }

  /** 搜索框回车：跳到第一个命中的文件 */
  function jumpToFirstHit() {
    const first = visibleFiles[0];
    if (first) setActive(first.path);
    else toast.info(`没有匹配：${keyword}`);
  }

  async function exportActive(
    kind: "png" | "svg" | "pdm" | "dbml" | "mermaid" | "md" | "ddl",
    scope: "all" | "view" = "all",
  ) {
    if (!activeFile) return;
    const base = activeFile.file_name.replace(/\.pdm$/i, "");
    if (kind === "png" || kind === "svg") {
      const el = wrapper.current;
      const { x, y, zoom } = getViewport();
      const crop =
        scope === "view" && el
          ? { x: -x / zoom, y: -y / zoom, width: el.clientWidth / zoom, height: el.clientHeight / zoom }
          : null;
      // 导出的图跟当前画布一致（搜索时只导命中的那部分）
      const hit = searching ? hits.get(activeFile.path) ?? null : null;
      const shown = hit ? filterGraph(activeFile.graph, hit) : activeFile.graph;
      await exportGraphImage({
        graph: shown,
        nodes,
        kind,
        baseName: `${base}-${scope === "view" ? "view" : "model"}`,
        crop,
        hits: hit ? [...hit.tables] : [],
      });
      return;
    }
    const ext =
      kind === "mermaid" ? "mmd" : kind === "md" ? "md" : kind === "dbml" ? "dbml" : kind === "pdm" ? "pdm" : "sql";
    const content =
      kind === "pdm"
        ? graphToPdm(activeFile.graph, activeFile.model_name)
        : kind === "dbml"
        ? graphToDbml(activeFile.graph)
        : kind === "mermaid"
          ? graphToMermaid(activeFile.graph)
          : kind === "md"
            ? graphToMarkdown(activeFile.graph)
            : graphToDdl(activeFile.graph);
    const picked = await save({
      defaultPath: `${base}-model.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!picked) return;
    const path = ensureExtension(picked, ext);
    await api.writeTextFile(path, content);
    toast.success("已导出");
  }

  const totalTables = files.reduce((n, f) => n + f.graph.tables.length, 0);
  const totalEdges = files.reduce((n, f) => n + f.graph.edges.length, 0);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b px-3 py-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" /> 返回
        </Button>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <FileCode2 className="size-4" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm leading-tight font-semibold">PDM Reader</h1>
          <p className="truncate text-xs text-muted-foreground">
            {files.length > 0
              ? `已打开 ${files.length} 个文件 · ${totalTables} 张表 · ${totalEdges} 条外键`
              : "打开 PowerDesigner 的 .pdm 文件离线查看"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-64">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="全局搜索表名 / 字段名（回车跳到命中）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && jumpToFirstHit()}
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={loading}>
                <History className="size-4" /> 最近
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>最近打开</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {recent.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">还没有打开过 PDM 文件</div>
              ) : (
                recent.map((r) => {
                  const opened = files.some((f) => f.path === r.path);
                  return (
                    <DropdownMenuItem
                      key={r.id}
                      onSelect={() => void openPaths([r.path])}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="truncate text-sm">{r.file_name}</span>
                        {opened && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            已打开
                          </span>
                        )}
                      </span>
                      <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                        {r.path}
                      </span>
                    </DropdownMenuItem>
                  );
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => void openFiles()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <FileCode2 className="size-4" />} 打开 PDM
          </Button>
        </div>
      </header>

      {files.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <FileCode2 className="size-10 opacity-40" />
          <p>还没有打开任何 PDM 文件</p>
          <Button variant="outline" size="sm" onClick={() => void openFiles()}>
            打开 .pdm 文件（可多选）
          </Button>
          {recent.length > 0 && (
            <div className="mt-4 w-full max-w-md">
              <div className="mb-2 flex items-center gap-1.5 text-xs">
                <History className="size-3.5" /> 最近打开
              </div>
              <div className="overflow-hidden rounded-lg border">
                {recent.slice(0, 6).map((r) => (
                  <button
                    key={r.id}
                    className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-foreground last:border-b-0 hover:bg-muted"
                    onClick={() => void openPaths([r.path])}
                  >
                    <span className="truncate text-sm">{r.file_name}</span>
                    <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                      {r.path}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
                这些记录来自本地库，关掉标签不会丢，可以随时从这里重开
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 文件标签栏：固定宽度 + 横向滚动 + 左右箭头；搜索时只留命中的 */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
            <Button
              size="icon-xs"
              variant="ghost"
              title="向左滚动"
              onClick={() => scrollTabs(-1)}
              className="shrink-0"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <div
              ref={tabStrip}
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {visibleFiles.map((f) => {
                const isActive = activeFile?.path === f.path;
                const hit = searching ? hits.get(f.path) : null;
                return (
                  <button
                    key={f.path}
                    title={f.path}
                    onClick={() => setActive(f.path)}
                    className={cn(
                      "group/tab flex h-7 w-44 flex-none items-center gap-1.5 rounded-md border px-2 text-left text-xs transition",
                      isActive ? "border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted",
                      // 搜索命中：蓝色闪动标记
                      searching && hit && "border-sky-400 bg-sky-50 text-sky-700 animate-pulse dark:bg-sky-400/10 dark:text-sky-300",
                    )}
                  >
                    <FileCode2 className={cn("size-3.5 shrink-0", searching && hit && "text-sky-500")} />
                    <span className="min-w-0 flex-1 truncate">{f.file_name}</span>
                    {searching && hit && (
                      <span className="shrink-0 rounded bg-sky-500/15 px-1 text-[10px] text-sky-600 dark:text-sky-300">
                        {hit.tables.size}
                      </span>
                    )}
                    <span
                      aria-hidden
                      title="关闭"
                      className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 group-hover/tab:opacity-100 hover:bg-muted"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFile(f.path);
                      }}
                    >
                      <X className="size-3" />
                    </span>
                  </button>
                );
              })}
              {searching && visibleFiles.length === 0 && (
                <span className="px-2 text-xs text-muted-foreground">没有文件命中「{keyword}」</span>
              )}
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              title="向右滚动"
              onClick={() => scrollTabs(1)}
              className="shrink-0"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>

          {/* 工具栏 */}
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
            <span className="shrink-0 font-medium">{activeFile?.file_name}</span>
            {activeFile && (
              <>
                <span className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {activeFile.model_name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {activeFile.graph.tables.length} 张表 · {activeFile.graph.edges.length} 条外键
                </span>
              </>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                title="重新布局"
                onClick={() => {
                  if (!activeFile) return;
                  setNodes(
                    layoutGraph(activeFile.graph, {
                      width: canvasSize.width,
                      height: canvasSize.height,
                      showComments,
                    }),
                  );
                  setEdges(graphEdges(activeFile.graph));
                  window.setTimeout(() => void fitView({ padding: 0.15, duration: 200 }), 50);
                }}
              >
                <WandSparkles className="size-3.5" /> 重新布局
              </Button>
              <Button
                size="xs"
                variant={showComments ? "secondary" : "ghost"}
                title="在图上显示字段注释 / 逻辑名"
                onClick={() => setShowComments((v) => !v)}
              >
                <StickyNote className="size-3.5" /> 注释
              </Button>
              <Button
                size="xs"
                variant={editing ? "secondary" : "ghost"}
                title="开启后可以新建 / 编辑 / 删除表（只改模型，不碰数据库）"
                onClick={() => setEditing((v) => !v)}
              >
                <Pencil className="size-3.5" /> 编辑
              </Button>
              {editing && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setEditTarget(null);
                    setEditOpen(true);
                  }}
                >
                  <Plus className="size-3.5" /> 新建表
                </Button>
              )}
              {activeFile && dirty.has(activeFile.path) && (
                <Button size="xs" variant="ghost" title="撤销本文件的全部模型改动" onClick={undoAll}>
                  <RotateCcw className="size-3.5" /> 撤销修改
                </Button>
              )}
              <Button size="xs" variant="outline" onClick={() => setCompareDbOpen(true)}>
                <GitCompare className="size-3.5" /> 对比数据库
              </Button>
              <Button size="xs" variant="ghost" title="适应画布" onClick={() => void fitView({ padding: 0.15, duration: 200 })}>
                <Maximize2 className="size-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="outline">
                    <Download className="size-3.5" /> 导出
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-max">
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("png")}>
                    导出 PNG · 整个模型
                  </DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("svg")}>
                    导出 SVG · 整个模型
                  </DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("png", "view")}>
                    导出 PNG · 当前视图
                  </DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("svg", "view")}>
                    导出 SVG · 当前视图
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("pdm")}>
                    导出 PDM（PowerDesigner）
                  </DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("ddl")}>
                    导出 DDL · 建表语句
                  </DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("dbml")}>
                    导出 DbML
                  </DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("mermaid")}>
                    导出 Mermaid erDiagram
                  </DropdownMenuItem>
                  <DropdownMenuItem className="whitespace-nowrap" onSelect={() => void exportActive("md")}>
                    导出 Markdown 表清单
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {editing && (
            <div className="shrink-0 border-b bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
              编辑模式：双击表节点改表，或点「新建表」；改动只在这个模型里，导出 DDL / PDM 或对比数据库时才用到
            </div>
          )}
          <div ref={wrapper} className="relative min-h-0 flex-1">
            {nodes.length === 0 && searching ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {visibleFiles.length === 0
                  ? `没有任何打开的文件命中「${keyword}」`
                  : `这个文件里没有命中「${keyword}」的表或字段`}
              </div>
            ) : nodes.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                这个 PDM 里没有表
              </div>
            ) : (
              <ErCanvas
                nodes={nodes}
                edges={edges}
                pdmNotes={noteApi}
                onNodesChange={onNodesChange as never}
                onEdgesChange={onEdgesChange as never}
                onNodeDoubleClick={(table) => {
                  if (editing) {
                    const row = activeFile?.graph.tables.find((t) => t.name === table) ?? null;
                    setEditTarget(row);
                    setEditOpen(true);
                    return;
                  }
                  const node = nodes.find((n) => n.id === table);
                  if (node) {
                    void setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + 60, { zoom: 1.2, duration: 300 });
                  }
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* 正向建模：编辑 / 新建表（只改模型） */}
      <ModelTableDialog
        open={editOpen}
        table={editTarget}
        otherTables={editOtherTables}
        edges={editEdges}
        onClose={() => {
          setEditOpen(false);
          setEditTarget(null);
        }}
        onSave={(table, tableEdges) => saveTable(editTarget?.name ?? null, table, tableEdges)}
        onDelete={editTarget ? () => deleteTable(editTarget.name) : undefined}
      />

      {/* 从 PDM 侧比数据库 */}
      <CompareDbDialog open={compareDbOpen} onClose={() => setCompareDbOpen(false)} onPicked={setCompared} />
      {compared && activeFile && (
        <ModelDiffPanel
          open
          onClose={() => setCompared(null)}
          base={compared.graph}
          target={activeFile.graph}
          baseLabel={compared.label}
          targetLabel={activeFile.file_name}
          flavor={compared.flavor}
          scopeKey={diffScopeKey({
            connectionId: compared.connectionId,
            database: compared.database,
            target: activeFile.path,
          })}
          connectionId={compared.connectionId}
          database={compared.database}
        />
      )}

      {/* 字段笔记浮层（Tiptap + 斜杠命令，按 markdown 存本地库） */}
      {noteTarget && activeFile && (
        <PdmNoteEditor
          key={`${activeFile.id}:${noteTarget.table}:${noteTarget.column}`}
          target={noteTarget}
          initial={notes.get(pdmNoteKey(noteTarget.table, noteTarget.column)) ?? ""}
          onSave={(md) => void saveNote(noteTarget.table, noteTarget.column, md)}
          onClose={() => setNoteTarget(null)}
        />
      )}
    </div>
  );
}

export function PdmPage() {
  const setView = useAppStore((s) => s.setView);
  return (
    <ReactFlowProvider>
      <PdmWorkspace onBack={() => setView("connections")} />
    </ReactFlowProvider>
  );
}
