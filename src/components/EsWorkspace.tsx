import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  FileJson,
  ListFilter,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  bodyJson,
  buildBody,
  buildPreview,
  collectFields,
  newGroup,
  type EsNode,
  type EsSortField,
} from "@/lib/esQuery";
import { cn } from "@/lib/utils";
import type { EsClusterInfo, EsSearchResult } from "@/lib/types";
import { useAppStore } from "@/store/app";
import { AiAssistantDrawer } from "./AiAssistantDrawer";
import { DocumentTable } from "./DocumentTable";
import { EsQueryBuilder } from "./EsQueryBuilder";
import { ThemeToggle } from "./ThemeToggle";

const DEFAULT_SIZE = 20;

/** 新建索引 body 的示例（顶层只认 settings / mappings / aliases） */
const INDEX_BODY_EXAMPLE = `{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": { "properties": { "title": { "type": "text" } } }
}`;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function pretty(v: unknown): string {
  if (v == null) return String(v);
  return JSON.stringify(v, null, 2);
}

export function EsWorkspace() {
  const { activeId, connections, setView, setError } = useAppStore();
  const active = connections.find((c) => c.id === activeId);

  const [cluster, setCluster] = useState<EsClusterInfo | null>(null);
  const [indices, setIndices] = useState<string[]>([]);
  const [indexSearch, setIndexSearch] = useState("");
  const [index, setIndex] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);

  const [root, setRoot] = useState<EsNode>(() => newGroup("must"));
  const [sorts, setSorts] = useState<EsSortField[]>([]);
  const [size, setSize] = useState(String(DEFAULT_SIZE));
  const [from, setFrom] = useState("0");
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const [rawBody, setRawBody] = useState("{\n  \n}");

  const [result, setResult] = useState<EsSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<unknown | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // 新建索引 / 写入文档 / 删除索引
  const [createIndexOpen, setCreateIndexOpen] = useState(false);
  const [newIndexName, setNewIndexName] = useState("");
  const [newIndexBody, setNewIndexBody] = useState("");
  const [addDocOpen, setAddDocOpen] = useState(false);
  const [newDocId, setNewDocId] = useState("");
  const [newDocBody, setNewDocBody] = useState("{\n  \n}");
  const [deleteIndexOpen, setDeleteIndexOpen] = useState(false);
  const [deleteIndexConfirm, setDeleteIndexConfirm] = useState("");
  const didInitialLoad = useRef<string | null>(null);

  const sizeNum = Math.max(1, Number(size) || DEFAULT_SIZE);
  const fromNum = Math.max(0, Number(from) || 0);

  const spec = useMemo(
    () => buildBody(root, sorts, sizeNum, fromNum),
    [root, sorts, sizeNum, fromNum],
  );
  const preview = useMemo(() => buildPreview(index ?? "", spec), [index, spec]);

  /** 「生成的查询」里要显示的文本：JSON 模式下把原始 body 也美化一下 */
  const previewText = useMemo(() => {
    if (mode !== "json") return preview;
    let body = rawBody;
    try {
      body = JSON.stringify(JSON.parse(rawBody), null, 2);
    } catch {
      // 还没写完整就先原样显示
    }
    return `POST /${index ?? "<index>"}/_search\n${body}`;
  }, [mode, preview, rawBody, index]);

  useEffect(() => {
    if (!activeId) return;
    if (didInitialLoad.current === activeId) return;
    didInitialLoad.current = activeId;
    void loadCluster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  async function loadCluster() {
    if (!activeId) return;
    try {
      setCluster(await api.esClusterInfo(activeId));
    } catch {
      // 集群信息拿不到不影响使用，忽略
    }
    await loadIndices();
  }

  async function loadIndices() {
    if (!activeId) return;
    try {
      setIndices(await api.esIndices(activeId));
    } catch (e) {
      setError(String(e));
    }
  }

  async function execSearch(idx: string, body: string) {
    if (!activeId) return;
    setLoading(true);
    try {
      setResult(await api.esSearch(activeId, idx, body));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function selectIndex(name: string) {
    if (!activeId) return;
    setIndex(name);
    setFrom("0");
    setRoot(newGroup("must"));
    setSorts([]);
    setMode("visual");
    setFields([]);
    void api.esFields(activeId, name).then(setFields).catch(() => {});
    void execSearch(name, JSON.stringify({ size: sizeNum }));
  }

  function run() {
    if (!index) return;
    if (mode === "json") {
      try {
        JSON.parse(rawBody);
      } catch (e) {
        setError(`查询体不是合法 JSON：${String(e)}`);
        return;
      }
      void execSearch(index, rawBody);
    } else {
      void execSearch(index, JSON.stringify(bodyJson(spec)));
    }
  }

  function switchMode(next: "visual" | "json") {
    if (next === "json" && mode === "visual") {
      setRawBody(JSON.stringify(bodyJson(spec), null, 2));
    }
    setMode(next);
  }

  function refresh() {
    if (index) run();
    else void loadIndices();
  }

  function resetBuilder() {
    setRoot(newGroup("must"));
    setSorts([]);
    setSize(String(DEFAULT_SIZE));
    setFrom("0");
    setRawBody("{\n  \n}");
    setMode("visual");
  }

  function gotoPage(delta: number) {
    if (!index) return;
    const next = Math.max(0, fromNum + delta * sizeNum);
    setFrom(String(next));
    if (mode === "json") {
      try {
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        body.from = next;
        body.size = sizeNum;
        setRawBody(JSON.stringify(body, null, 2));
        void execSearch(index, JSON.stringify(body));
      } catch (e) {
        setError(String(e));
      }
    } else {
      void execSearch(index, JSON.stringify(bodyJson(buildBody(root, sorts, sizeNum, next))));
    }
  }

  const columns = useMemo(() => {
    const docs = result?.documents ?? [];
    const order: string[] = [];
    const seen = new Set<string>();
    for (const doc of docs) {
      if (doc && typeof doc === "object" && !Array.isArray(doc)) {
        for (const key of Object.keys(doc as Record<string, unknown>)) {
          if (!seen.has(key)) {
            seen.add(key);
            order.push(key);
          }
        }
      }
    }
    order.sort((a, b) => {
      if (a === "_id") return -1;
      if (b === "_id") return 1;
      return 0;
    });
    return order;
  }, [result]);

  const fieldOptions = useMemo(
    () => Array.from(new Set([...fields, ...columns, ...collectFields(root)])),
    [fields, columns, root],
  );

  const filteredIndices = useMemo(() => {
    const q = indexSearch.trim().toLowerCase();
    if (!q) return indices;
    return indices.filter((c) => c.toLowerCase().includes(q));
  }, [indices, indexSearch]);

  function docValue(doc: unknown, key: string): unknown {
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      return (doc as Record<string, unknown>)[key];
    }
    return undefined;
  }

  async function deleteDetail() {
    if (!activeId || !index || detail == null) return;
    const id = docValue(detail, "_id");
    if (typeof id !== "string") return;
    try {
      await api.esDeleteDoc(activeId, index, id);
      setDetail(null);
      run();
    } catch (e) {
      setError(String(e));
    }
  }

  async function createIndex() {
    if (!activeId) return;
    const name = newIndexName.trim();
    if (!name) return;
    try {
      await api.esCreateIndex(activeId, name, newIndexBody);
      setCreateIndexOpen(false);
      setNewIndexName("");
      setNewIndexBody("");
      await loadIndices();
      await selectIndex(name);
      toast.success(`已创建索引 ${name}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function addDocument() {
    if (!activeId || !index) return;
    try {
      JSON.parse(newDocBody);
    } catch (e) {
      setError(`文档不是合法 JSON：${String(e)}`);
      return;
    }
    try {
      const res = (await api.esIndexDoc(
        activeId,
        index,
        newDocId.trim() || null,
        newDocBody,
      )) as { _id?: string } | null;
      setAddDocOpen(false);
      setNewDocId("");
      setNewDocBody("{\n  \n}");
      toast.success(res?._id ? `已写入，_id: ${res._id}` : "已写入文档");
      run();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteIndex() {
    if (!activeId || !index) return;
    if (deleteIndexConfirm.trim() !== index) {
      setError("索引名不一致，未删除");
      return;
    }
    const name = index;
    try {
      await api.esDeleteIndex(activeId, name);
      setDeleteIndexOpen(false);
      setDeleteIndexConfirm("");
      setIndex(null);
      setResult(null);
      await loadIndices();
      toast.success(`已删除索引 ${name}`);
    } catch (e) {
      setError(String(e));
    }
  }

  const page = Math.floor(fromNum / sizeNum) + 1;
  const totalPages = Math.max(1, Math.ceil((result?.total ?? 0) / sizeNum));

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => setView("connections")}>
          <ArrowLeft className="size-4" /> 返回
        </Button>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Database className="size-4" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm leading-tight font-semibold">{active?.name ?? "Elasticsearch"}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {active?.host}:{active?.port}
            {cluster ? ` · ${cluster.name}${cluster.version ? ` ${cluster.version}` : ""}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant={assistantOpen ? "secondary" : "ghost"}
            title="AI 助手"
            onClick={() => setAssistantOpen((v) => !v)}
          >
            <Sparkles className="size-3.5" /> AI
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <div className="space-y-2 border-b p-3">
            <Label className="text-xs text-muted-foreground">索引</Label>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-7 font-mono"
                  placeholder="搜索索引"
                  value={indexSearch}
                  onChange={(e) => setIndexSearch(e.target.value)}
                />
              </div>
              <Button
                size="icon-sm"
                variant="outline"
                title="新建索引"
                onClick={() => setCreateIndexOpen(true)}
              >
                <Plus className="size-3.5" />
              </Button>
              <Button size="icon-sm" variant="outline" title="刷新索引" onClick={() => void loadIndices()}>
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filteredIndices.length === 0 && (
              <div className="space-y-2 p-4 text-center text-xs text-muted-foreground">
                <div>没有索引</div>
                <Button size="xs" variant="outline" onClick={() => setCreateIndexOpen(true)}>
                  <Plus className="size-3" /> 新建索引
                </Button>
              </div>
            )}
            {filteredIndices.map((name) => (
              <button
                key={name}
                onClick={() => void selectIndex(name)}
                className={cn(
                  "flex w-full items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left font-mono text-xs transition hover:bg-muted",
                  index === name && "bg-muted text-foreground",
                )}
              >
                <FileJson className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {!index ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              选择一个索引查看文档
            </div>
          ) : (
            <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
              {/* 上方：命中结果 */}
              <ResizablePanel className="flex min-h-0 flex-col" style={{ overflow: "hidden" }}>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
                  <FileJson className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono font-medium">{index}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    命中 {result?.total ?? 0} · ES {result?.took_ms ?? 0}ms · {result?.elapsed_ms ?? 0}ms
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Button size="icon-xs" variant="ghost" disabled={fromNum <= 0} onClick={() => gotoPage(-1)}>
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {page} / {totalPages}
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={page >= totalPages}
                      onClick={() => gotoPage(1)}
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>
                    <Button size="xs" variant="ghost" onClick={refresh}>
                      <RefreshCw className="size-3.5" /> 刷新
                    </Button>
                    <Button size="xs" onClick={() => setAddDocOpen(true)}>
                      <Plus className="size-3.5" /> 写入文档
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      title="删除索引"
                      onClick={() => {
                        setDeleteIndexConfirm("");
                        setDeleteIndexOpen(true);
                      }}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                  {loading ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  ) : (result?.documents.length ?? 0) === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      没有命中的文档
                    </div>
                  ) : (
                    <DocumentTable
                      columns={columns}
                      documents={result?.documents ?? []}
                      renderCell={(doc, c) => cellText(docValue(doc, c))}
                      onRowClick={setDetail}
                      empty="没有命中的文档"
                    />
                  )}
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* 下方：查询构建器 + DSL 预览 */}
              <ResizablePanel
                defaultSize={330}
                groupResizeBehavior="preserve-pixel-size"
                className="flex min-h-0 flex-col"
                style={{ overflow: "hidden" }}
              >
                <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
                  <ListFilter className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">查询构建器</span>
                  <div className="ml-2 flex items-center rounded-md border bg-background p-0.5">
                    {(["visual", "json"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => switchMode(m)}
                        className={cn(
                          "rounded px-2 py-0.5 text-[11px] font-medium transition",
                          mode === m
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {m === "visual" ? "可视化" : "JSON"}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="xs" variant="ghost" onClick={resetBuilder}>
                      <RotateCcw className="size-3" /> 重置
                    </Button>
                    <Button size="xs" disabled={loading} onClick={run}>
                      {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3" />}
                      运行
                    </Button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1">
                  <div className="min-w-0 flex-1 overflow-auto p-3">
                    {mode === "visual" ? (
                      <EsQueryBuilder
                        root={root}
                        onChange={setRoot}
                        sorts={sorts}
                        onSortsChange={setSorts}
                        size={size}
                        onSizeChange={setSize}
                        from={from}
                        onFromChange={setFrom}
                        fields={fieldOptions}
                      />
                    ) : (
                      <Textarea
                        value={rawBody}
                        onChange={(e) => setRawBody(e.target.value)}
                        className="h-full min-h-40 resize-none font-mono text-xs"
                        spellCheck={false}
                      />
                    )}
                  </div>
                  <div className="w-px shrink-0 bg-border" />
                  <div className="flex w-[36%] min-w-56 shrink-0 flex-col">
                    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b px-3 text-xs text-muted-foreground">
                      <Code2 className="size-3.5" /> 生成的查询
                      <Button
                        size="xs"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => {
                          void copyText(preview).then((ok) => {
                            if (ok) toast.success("已复制");
                          });
                        }}
                      >
                        <Copy className="size-3" /> 复制
                      </Button>
                    </div>
                    <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                      {previewText}
                    </pre>
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </main>
      </div>

      {/* 文档详情 */}
      <Dialog open={detail != null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>文档</DialogTitle>
            <p className="text-sm text-muted-foreground">命中的文档（含 _id / _index / _score）</p>
          </DialogHeader>
          <Textarea
            value={detail == null ? "" : pretty(detail)}
            readOnly
            className="min-h-72 flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={() => void deleteDetail()}>
              <Trash2 className="size-3.5 text-destructive" /> 删除
            </Button>
            <Button variant="outline" onClick={() => setDetail(null)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 新建索引 */}
      <Dialog open={createIndexOpen} onOpenChange={(o) => !o && setCreateIndexOpen(false)}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>新建索引</DialogTitle>
            <p className="text-sm text-muted-foreground">
              索引名用小写，可含 <span className="font-mono">-</span> 和 <span className="font-mono">_</span>；下面是可选的 settings / mappings。
            </p>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>索引名</Label>
            <Input
              value={newIndexName}
              onChange={(e) => setNewIndexName(e.target.value)}
              placeholder="logs-2026.10"
              className="font-mono"
            />
            <div className="mt-2 flex items-center justify-between">
              <Label>索引定义（可选 JSON）</Label>
              <Button size="xs" variant="ghost" onClick={() => setNewIndexBody(INDEX_BODY_EXAMPLE)}>
                填入示例
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              留空即用默认配置；顶层只支持{" "}
              <span className="font-mono">settings</span>、<span className="font-mono">mappings</span>、
              <span className="font-mono">aliases</span> 三个键。
            </p>
            <Textarea
              value={newIndexBody}
              onChange={(e) => setNewIndexBody(e.target.value)}
              placeholder={INDEX_BODY_EXAMPLE}
              className="min-h-48 font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateIndexOpen(false)}>取消</Button>
            <Button disabled={!newIndexName.trim()} onClick={() => void createIndex()}>
              <Plus className="size-3.5" /> 创建
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 写入文档 */}
      <Dialog open={addDocOpen} onOpenChange={(o) => !o && setAddDocOpen(false)}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>写入文档</DialogTitle>
            <p className="text-sm text-muted-foreground">
              写入 <span className="font-mono">{index}</span>；_id 留空则由 ES 生成。
            </p>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>_id（可选）</Label>
            <Input
              value={newDocId}
              onChange={(e) => setNewDocId(e.target.value)}
              placeholder="留空自动生成"
              className="font-mono"
            />
            <Label className="mt-2">文档 JSON</Label>
            <Textarea
              value={newDocBody}
              onChange={(e) => setNewDocBody(e.target.value)}
              className="min-h-56 font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="outline" onClick={() => setAddDocOpen(false)}>取消</Button>
            <Button onClick={() => void addDocument()}>
              <Plus className="size-3.5" /> 写入
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除索引 */}
      <Dialog open={deleteIndexOpen} onOpenChange={(o) => !o && setDeleteIndexOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除索引</DialogTitle>
            <p className="text-sm text-muted-foreground">
              会连同里面的所有文档一起删掉，不可恢复。输入索引名{" "}
              <span className="font-mono">{index}</span> 确认。
            </p>
          </DialogHeader>
          <Input
            value={deleteIndexConfirm}
            onChange={(e) => setDeleteIndexConfirm(e.target.value)}
            placeholder={index ?? ""}
            className="font-mono"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteIndexOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              disabled={deleteIndexConfirm.trim() !== index}
              onClick={() => void deleteIndex()}
            >
              <Trash2 className="size-3.5" /> 删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AiAssistantDrawer
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        connectionId={activeId}
        database={cluster?.name ?? ""}
        table={index}
        seed={null}
        onInsertSql={() => {}}
        onOpenSettings={() => setView("settings")}
      />
    </div>
  );
}
