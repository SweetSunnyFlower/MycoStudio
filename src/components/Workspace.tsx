import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Database, Network, Sparkles, Table2, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Filter } from "@/lib/types";
import { useAppStore } from "@/store/app";
import { ObjectExplorer } from "./ObjectExplorer";
import { SqlPanel } from "./SqlPanel";
import { TablePanel } from "./TablePanel";
import { ModelPanel } from "./ModelPanel";
import { ThemeToggle } from "./ThemeToggle";
import { CreateTableDialog } from "./CreateTableDialog";
import { AiAssistantDrawer } from "./AiAssistantDrawer";
import { RedisWorkspace } from "./RedisWorkspace";
import { MongoWorkspace } from "./MongoWorkspace";
import { EsWorkspace } from "./EsWorkspace";

const SQL_TAB = "sql";
/** 常在的「模型」标签：把当前库的物理模型（真实外键）画成 ER 图 */
const MODEL_TAB = "model";

interface TableTab {
  db: string;
  table: string;
  /** 由 SQL 解析出来的初始筛选/排序；nonce 变化时对应 tab 会重新套用 */
  seed?: {
    filters: Filter[];
    sort: { column: string; dir: "asc" | "desc" } | null;
    /** 触发这次加载的 SQL，回填到表 tab 的编辑器里 */
    sql?: string;
    nonce: number;
  };
}

const keyOf = (t: TableTab) => `${t.db}\u0000${t.table}`;

let seedNonce = 0;

export function Workspace() {
  const { activeId, connections, databases, setDatabases, setView, setError } = useAppStore();
  const active = connections.find((c) => c.id === activeId);

  const [database, setDatabase] = useState("");
  const [sql, setSql] = useState("");
  const [openTabs, setOpenTabs] = useState<TableTab[]>([]);
  const [activeTab, setActiveTab] = useState<string>(SQL_TAB);
  const [createTableDb, setCreateTableDb] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState<{ text: string; nonce: number } | null>(null);
  const aiSeedNonce = useRef(0);

  /** 让 AI 助手带着一条预设指令打开（SQL 编辑器里的快捷入口用） */
  function askAi(prompt: string) {
    setAssistantOpen(true);
    setAssistantSeed({ text: prompt, nonce: ++aiSeedNonce.current });
  }

  useEffect(() => {
    // 初始默认库：连接里配的那个如果确实在库列表里就用它，否则用列表第一个。
    // （Oracle 连接里填的是「服务名」，它不是 schema，直接拿来当库名会切不过去）
    setDatabase((prev) => {
      if (prev) return prev;
      const fromConn = active?.database ?? "";
      return databases.includes(fromConn) ? fromConn : (databases[0] ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, databases]);

  async function refresh() {
    if (!activeId) return;
    try {
      setDatabases(await api.listDatabases(activeId));
    } catch (e) {
      setError(String(e));
    }
  }

  // 切换数据库只切到 SQL 标签，保留已打开的表标签
  function selectDatabase(db: string) {
    setDatabase(db);
    setActiveTab(SQL_TAB);
  }

  function openTable(
    db: string,
    table: string,
    seed?: { filters: Filter[]; sort: { column: string; dir: "asc" | "desc" } | null; sql?: string },
  ) {
    setDatabase(db);
    const nextSeed = seed ? { ...seed, nonce: ++seedNonce } : undefined;
    setOpenTabs((prev) => {
      const key = keyOf({ db, table });
      const idx = prev.findIndex((t) => keyOf(t) === key);
      if (idx < 0) return [...prev, { db, table, seed: nextSeed }];
      if (!nextSeed) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], seed: nextSeed };
      return next;
    });
    setActiveTab(keyOf({ db, table }));
  }

  function queryTable(db: string, table: string) {
    const quoted =
      active?.flavor === "sqlite" || active?.flavor === "postgres" || active?.flavor === "oracle"
        ? `"${table}"`
        : `\`${table}\``;
    const limit = active?.flavor === "oracle" ? "FETCH FIRST 100 ROWS ONLY" : "LIMIT 100";
    setSql(`SELECT *\nFROM ${quoted}\n${limit};`);
    setDatabase(db);
    setActiveTab(SQL_TAB);
  }

  function createTable(db: string) {
    setCreateTableDb(db);
  }

  function closeTab(tab: TableTab) {
    const key = keyOf(tab);
    const next = openTabs.filter((t) => keyOf(t) !== key);
    setOpenTabs(next);
    if (activeTab === key) {
      setActiveTab(next.length > 0 ? keyOf(next[next.length - 1]) : SQL_TAB);
    }
  }

  const activeTabObj = openTabs.find((t) => keyOf(t) === activeTab) ?? null;

  // Redis 是非关系型，走一套完全不同的工作台；其余引擎沿用关系型那一套。
  if (active?.flavor === "redis") {
    return <RedisWorkspace />;
  }
  if (active?.flavor === "mongodb") {
    return <MongoWorkspace />;
  }
  if (active?.flavor === "elasticsearch") {
    return <EsWorkspace />;
  }

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
          <h1 className="truncate text-sm leading-tight font-semibold">{active?.name ?? "工作台"}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {active?.flavor === "sqlite" ? active.file_path : `${active?.host}:${active?.port}`}
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
        <aside className="w-72 shrink-0 overflow-hidden border-r">
          <ObjectExplorer
            activeDatabase={database}
            activeTable={activeTabObj?.table ?? null}
            openTables={openTabs.filter((t) => t.db === database).map((t) => t.table)}
            onSelectDatabase={selectDatabase}
            onSelectTable={openTable}
              onQueryTable={queryTable}
              onCreateTable={createTable}
              onRefresh={refresh}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList
              variant="line"
              className="h-9 w-full shrink-0 justify-start gap-0 overflow-x-auto overflow-y-hidden rounded-none border-b px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <TabsTrigger value={SQL_TAB} className="flex-none gap-1.5 px-3">
                <Terminal className="size-3.5" /> SQL
              </TabsTrigger>
              <TabsTrigger value={MODEL_TAB} className="flex-none gap-1.5 px-3">
                <Network className="size-3.5" /> 模型
              </TabsTrigger>
              {openTabs.map((tab) => {
                const key = keyOf(tab);
                return (
                  <TabsTrigger
                    key={key}
                    value={key}
                    title={tab.table}
                    className="group/tab w-40 flex-none gap-1.5 pr-1.5 pl-2.5"
                  >
                    <Table2 className="size-3.5 shrink-0" />
                    <span className="truncate font-mono text-xs">{tab.table}</span>
                    <span
                      aria-hidden
                      title="关闭标签"
                      className="ml-auto flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        closeTab(tab);
                      }}
                    >
                      <X className="size-3" />
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <TabsContent
              value={SQL_TAB}
              forceMount
              className={cn(
                "min-h-0 flex-1 flex-col",
                activeTab === SQL_TAB && "animate-in fade-in duration-150",
              )}
              style={{ display: activeTab === SQL_TAB ? "flex" : "none" }}
            >
              <SqlPanel
                database={database}
                sql={sql}
                onSqlChange={setSql}
                onAskAi={askAi}
                onTableQuery={(q, statement) => {
                  // 单表 SELECT：新开一个表 tab 并自动按 SQL 的条件加载
                  openTable(q.database ?? database, q.table, {
                    filters: q.filters,
                    sort: q.sort,
                    sql: statement,
                  });
                  return true;
                }}
              />
            </TabsContent>
            <TabsContent
              value={MODEL_TAB}
              forceMount
              className={cn(
                "min-h-0 flex-1 flex-col",
                activeTab === MODEL_TAB && "animate-in fade-in duration-150",
              )}
              style={{ display: activeTab === MODEL_TAB ? "flex" : "none" }}
            >
              <ModelPanel
                database={database}
                active={activeTab === MODEL_TAB}
                onOpenTable={openTable}
              />
            </TabsContent>
            {openTabs.map((tab) => (
              <TabsContent
                key={keyOf(tab)}
                value={keyOf(tab)}
                forceMount
                className={cn(
                  "min-h-0 flex-1 flex-col",
                  activeTab === keyOf(tab) && "animate-in fade-in duration-150",
                )}
                style={{ display: activeTab === keyOf(tab) ? "flex" : "none" }}
              >
                <TablePanel
                  database={tab.db}
                  table={tab.table}
                  seed={tab.seed}
                  onOpenTable={openTable}
                  onAskAi={askAi}
                />
              </TabsContent>
            ))}
          </Tabs>

          <CreateTableDialog
            open={!!createTableDb}
            database={createTableDb ?? ""}
            onClose={() => setCreateTableDb(null)}
            onCreated={(table) => {
              const db = createTableDb;
              setCreateTableDb(null);
              if (db) openTable(db, table);
            }}
          />
        </main>
      </div>

      <AiAssistantDrawer
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        connectionId={activeId}
        database={database}
        table={activeTabObj?.table ?? null}
        seed={assistantSeed}
        onInsertSql={(sql) => {
          setSql(sql);
          setActiveTab(SQL_TAB);
        }}
        onOpenSettings={() => setView("settings")}
      />
    </div>
  );
}
