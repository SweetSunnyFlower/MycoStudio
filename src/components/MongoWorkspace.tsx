import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  ListFilter,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  buildQuery,
  collectFields,
  compileFilter,
  compileSort,
  newGroup,
  type MongoNode,
  type MongoSortField,
} from "@/lib/mongoQuery";
import { cn } from "@/lib/utils";
import type { MongoQueryResult } from "@/lib/types";
import { useAppStore } from "@/store/app";
import { AiAssistantDrawer } from "./AiAssistantDrawer";
import { DocumentTable } from "./DocumentTable";
import { MongoQueryBuilder } from "./MongoQueryBuilder";
import { ThemeToggle } from "./ThemeToggle";

const PAGE_SIZE = 200;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      if (keys[0] === "$oid" && typeof obj.$oid === "string") return obj.$oid;
      if (keys[0] === "$date") {
        const d = obj.$date as Record<string, unknown> | string | undefined;
        if (d && typeof d === "object" && typeof d.$numberLong === "string") {
          const ms = Number(d.$numberLong);
          if (!Number.isNaN(ms)) return new Date(ms).toISOString();
        }
        if (typeof d === "string") return d;
      }
      if (
        (keys[0] === "$numberLong" ||
          keys[0] === "$numberInt" ||
          keys[0] === "$numberDouble") &&
        typeof obj[keys[0]] === "string"
      ) {
        return obj[keys[0]] as string;
      }
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function pretty(v: unknown): string {
  if (v == null) return String(v);
  return JSON.stringify(v, null, 2);
}

export function MongoWorkspace() {
  const { activeId, connections, databases, setView, setError } = useAppStore();
  const active = connections.find((c) => c.id === activeId);

  const [database, setDatabase] = useState<string | null>(null);
  const [collections, setCollections] = useState<string[]>([]);
  const [collection, setCollection] = useState<string | null>(null);
  const [collectionSearch, setCollectionSearch] = useState("");
  // 查询构建器：条件树 + 排序 + 分页
  const [root, setRoot] = useState<MongoNode>(() => newGroup("and"));
  const [sorts, setSorts] = useState<MongoSortField[]>([]);
  const [limit, setLimit] = useState(String(PAGE_SIZE));
  const [skip, setSkip] = useState("0");
  const [result, setResult] = useState<MongoQueryResult | null>(null);
  const [loading, setLoading] = useState(false);

  // 详情 / 编辑 / 新增
  const [detail, setDetail] = useState<unknown | null>(null);
  const [editJson, setEditJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newJson, setNewJson] = useState("{\n  \n}");

  const [assistantOpen, setAssistantOpen] = useState(false);
  const didInitialLoad = useRef<string | null>(null);

  // 选哪个库：用户点过的 → 连接里配的默认库 → 列表第一个。
  // 不要先用 databases[0] 顶上——库名是排序返回的，第一个往往是 admin，
  // 于是首次进工作台会去列 admin 的集合，而那次加载又被记成「已初始化」，
  // 后面 activeDb 变成正确的库也不会重新拉，只能手动刷新。
  const configuredDb = active?.database ?? "";
  const activeDb =
    database ?? (databases.includes(configuredDb) ? configuredDb : (databases[0] ?? ""));

  async function loadCollections(db: string) {
    if (!activeId) return;
    try {
      setCollections(await api.mongodbListCollections(activeId, db));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!activeId) return;
    if (!activeDb) return;
    if (didInitialLoad.current === activeId) return;
    didInitialLoad.current = activeId;
    setCollection(null);
    setResult(null);
    void loadCollections(activeDb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeDb]);

  function selectDb(db: string) {
    setDatabase(db);
    setCollection(null);
    setResult(null);
    void loadCollections(db);
  }

  async function execFind(coll: string, filter: string, sort: string, skipNum: number, limitNum: number) {
    if (!activeId) return;
    setLoading(true);
    try {
      setResult(await api.mongodbFind(activeId, activeDb, coll, filter, sort, skipNum, limitNum));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  /** 用当前构建器里的条件跑一次查询 */
  function currentQuery(coll: string) {
    const limitNum = Math.max(1, Number(limit) || PAGE_SIZE);
    const skipNum = Math.max(0, Number(skip) || 0);
    void execFind(
      coll,
      JSON.stringify(compileFilter(root)),
      JSON.stringify(compileSort(sorts)),
      skipNum,
      limitNum,
    );
  }

  function selectCollection(coll: string) {
    setCollection(coll);
    setSkip("0");
    // 换集合时把条件清空，重新开始
    setRoot(newGroup("and"));
    setSorts([]);
    void execFind(coll, "{}", "{}", 0, Math.max(1, Number(limit) || PAGE_SIZE));
  }

  function refresh() {
    if (collection) {
      currentQuery(collection);
    } else {
      void loadCollections(activeDb);
    }
  }

  function resetBuilder() {
    setRoot(newGroup("and"));
    setSorts([]);
    setLimit(String(PAGE_SIZE));
    setSkip("0");
  }

  function gotoPage(next: number) {
    if (!collection) return;
    const limitNum = Math.max(1, Number(limit) || PAGE_SIZE);
    const clamped = Math.max(0, next);
    setSkip(String(clamped * limitNum));
    void execFind(
      collection,
      JSON.stringify(compileFilter(root)),
      JSON.stringify(compileSort(sorts)),
      clamped * limitNum,
      limitNum,
    );
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
    // _id 固定放最前
    order.sort((a, b) => {
      if (a === "_id") return -1;
      if (b === "_id") return 1;
      return 0;
    });
    return order;
  }, [result]);

  const filteredCollections = useMemo(() => {
    const q = collectionSearch.trim().toLowerCase();
    if (!q) return collections;
    return collections.filter((c) => c.toLowerCase().includes(q));
  }, [collections, collectionSearch]);

  // 字段候选：当前结果里出现过的列 + 构建器里已经填过的字段
  const fieldOptions = useMemo(
    () => Array.from(new Set([...columns, ...collectFields(root)])),
    [columns, root],
  );

  const compiledFilter = useMemo(() => compileFilter(root), [root]);
  const compiledSort = useMemo(() => compileSort(sorts), [sorts]);
  const limitNum = Math.max(1, Number(limit) || PAGE_SIZE);
  const skipNum = Math.max(0, Number(skip) || 0);
  const preview = useMemo(
    () => buildQuery(collection ?? "", compiledFilter, compiledSort, skipNum, limitNum),
    [collection, compiledFilter, compiledSort, skipNum, limitNum],
  );

  function docValue(doc: unknown, key: string): unknown {
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      return (doc as Record<string, unknown>)[key];
    }
    return undefined;
  }

  function openDetail(doc: unknown) {
    setDetail(doc);
    setEditJson(pretty(doc));
  }

  function idFilter(doc: unknown): string {
    const id = docValue(doc, "_id");
    return JSON.stringify({ _id: id });
  }

  async function saveDetail() {
    if (!activeId || !collection || detail == null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editJson);
    } catch (e) {
      setError(`JSON 格式错误：${String(e)}`);
      return;
    }
    setSaving(true);
    try {
      await api.mongodbReplaceOne(
        activeId,
        activeDb,
        collection,
        idFilter(detail),
        JSON.stringify(parsed),
      );
      setDetail(null);
      currentQuery(collection);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteDetail() {
    if (!activeId || !collection || detail == null) return;
    try {
      await api.mongodbDeleteOne(activeId, activeDb, collection, idFilter(detail));
      setDetail(null);
      currentQuery(collection);
    } catch (e) {
      setError(String(e));
    }
  }

  async function insertOne() {
    if (!activeId || !collection) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(newJson);
    } catch (e) {
      setError(`JSON 格式错误：${String(e)}`);
      return;
    }
    try {
      await api.mongodbInsertOne(activeId, activeDb, collection, JSON.stringify(parsed));
      setAddOpen(false);
      setNewJson("{\n  \n}");
      currentQuery(collection);
    } catch (e) {
      setError(String(e));
    }
  }

  const totalPages = Math.max(1, Math.ceil((result?.total ?? 0) / limitNum));
  const page = Math.floor(skipNum / limitNum);

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
          <h1 className="truncate text-sm leading-tight font-semibold">{active?.name ?? "MongoDB"}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {active?.host}:{active?.port} · MongoDB
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
            <Label className="text-xs text-muted-foreground">数据库</Label>
            <Select value={activeDb} onValueChange={selectDb}>
              <SelectTrigger className="w-full font-mono"><SelectValue /></SelectTrigger>
              <SelectContent>
                {databases.map((db) => (
                  <SelectItem key={db} value={db}>{db}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-7 font-mono"
                  placeholder="搜索集合"
                  value={collectionSearch}
                  onChange={(e) => setCollectionSearch(e.target.value)}
                />
              </div>
              <Button size="icon-sm" variant="outline" onClick={() => void loadCollections(activeDb)}>
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filteredCollections.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">没有集合</div>
            )}
            {filteredCollections.map((c) => (
              <button
                key={c}
                onClick={() => selectCollection(c)}
                className={cn(
                  "flex w-full items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left font-mono text-xs transition hover:bg-muted",
                  collection === c && "bg-muted text-foreground",
                )}
              >
                <Boxes className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{c}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {!collection ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              选择一个集合查看文档
            </div>
          ) : (
            <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
              {/* 上方：文档表格 */}
              <ResizablePanel className="flex min-h-0 flex-col" style={{ overflow: "hidden" }}>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
                  <Boxes className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono font-medium">{collection}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    共 {result?.total ?? 0} · {result?.elapsed_ms ?? 0}ms
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Button size="icon-xs" variant="ghost" disabled={page === 0} onClick={() => gotoPage(page - 1)}>
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {page + 1} / {totalPages}
                    </span>
                    <Button size="icon-xs" variant="ghost" disabled={page + 1 >= totalPages} onClick={() => gotoPage(page + 1)}>
                      <ChevronRight className="size-3.5" />
                    </Button>
                    <Button size="xs" variant="ghost" onClick={refresh}>
                      <RefreshCw className="size-3.5" /> 刷新
                    </Button>
                    <Button size="xs" onClick={() => setAddOpen(true)}>
                      <Plus className="size-3.5" /> 新增文档
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
                      没有匹配的文档
                    </div>
                  ) : (
                    <DocumentTable
                      columns={columns}
                      documents={result?.documents ?? []}
                      renderCell={(doc, c) => cellText(docValue(doc, c))}
                      onRowClick={openDetail}
                      empty="没有匹配的文档"
                    />
                  )}
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* 下方：查询构建器 + 查询预览 */}
              <ResizablePanel
                defaultSize={330}
                groupResizeBehavior="preserve-pixel-size"
                className="flex min-h-0 flex-col"
                style={{ overflow: "hidden" }}
              >
                <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
                  <ListFilter className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">查询构建器</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="xs" variant="ghost" onClick={resetBuilder}>
                      <RotateCcw className="size-3" /> 重置
                    </Button>
                    <Button size="xs" disabled={loading} onClick={() => currentQuery(collection)}>
                      {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3" />}
                      运行
                    </Button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1">
                  <div className="min-w-0 flex-1 overflow-auto p-3">
                    <MongoQueryBuilder
                      root={root}
                      onChange={setRoot}
                      sorts={sorts}
                      onSortsChange={setSorts}
                      limit={limit}
                      onLimitChange={setLimit}
                      skip={skip}
                      onSkipChange={setSkip}
                      fields={fieldOptions}
                    />
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
                      {preview}
                    </pre>
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </main>
      </div>

      {/* 文档详情 / 编辑 */}
      <Dialog open={detail != null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>文档详情</DialogTitle>
            <p className="text-sm text-muted-foreground">直接编辑 JSON，保存时按 _id 整份替换</p>
          </DialogHeader>
          <Textarea
            value={editJson}
            onChange={(e) => setEditJson(e.target.value)}
            className="min-h-72 flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={() => void deleteDetail()}>
              <Trash2 className="size-3.5 text-destructive" /> 删除
            </Button>
            <Button variant="outline" onClick={() => setDetail(null)}>取消</Button>
            <Button disabled={saving} onClick={() => void saveDetail()}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 新增文档 */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && setAddOpen(false)}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>新增文档</DialogTitle>
            <p className="text-sm text-muted-foreground">不填 _id 时由 MongoDB 自动生成 ObjectId</p>
          </DialogHeader>
          <Textarea
            value={newJson}
            onChange={(e) => setNewJson(e.target.value)}
            className="min-h-72 flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
            <Button onClick={() => void insertOne()}>
              <Plus className="size-3.5" /> 插入
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AiAssistantDrawer
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        connectionId={activeId}
        database={activeDb}
        table={collection}
        seed={null}
        // MongoDB 里没有 SQL 编辑器可插入，AI 给的查询用复制即可
        onInsertSql={() => {}}
        onOpenSettings={() => setView("settings")}
      />
    </div>
  );
}
