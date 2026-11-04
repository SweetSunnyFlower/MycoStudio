import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { ChevronRight, Database, Loader2, Plus, RefreshCw, Search, SquareTerminal, Table2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { TableInfo } from "@/lib/types";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";

interface Props {
  activeDatabase: string;
  activeTable: string | null;
  openTables: string[];
  onSelectDatabase: (db: string) => void;
  onSelectTable: (db: string, table: string) => void;
  onQueryTable: (db: string, table: string) => void;
  onCreateTable: (db: string) => void;
  onRefresh: () => Promise<void> | void;
}

export function ObjectExplorer({
  activeDatabase,
  activeTable,
  openTables,
  onSelectDatabase,
  onSelectTable,
  onQueryTable,
  onCreateTable,
  onRefresh,
}: Props) {
  const { activeId, databases } = useAppStore();
  const flavor = useAppStore((s) => s.connections.find((c) => c.id === s.activeId)?.flavor);
  const isSqlite = flavor === "sqlite";
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setExpanded({});
    setTables({});
  }, [activeId]);

  const query = search.trim().toLowerCase();
  // 支持 "库.表" 形式的搜索：第一个点前面是库名片段，后面是表名片段
  const dotIndex = query.indexOf(".");
  const dbPart = dotIndex >= 0 ? query.slice(0, dotIndex) : query;
  const tablePart = dotIndex >= 0 ? query.slice(dotIndex + 1) : "";

  /** 库名是否命中（点号前那段） */
  function dbNameMatches(db: string) {
    return dbPart.length > 0 && db.toLowerCase().includes(dbPart);
  }

  /** 表名是否命中（"库.表" 时只比对点号后的那段） */
  function tableMatches(table: string) {
    const needle = dotIndex >= 0 ? tablePart : query;
    return needle.length === 0 || table.toLowerCase().includes(needle);
  }

  const visibleDbs = query
    ? databases.filter((db) => dbNameMatches(db) || (tables[db] ?? []).some((t) => tableMatches(t.name)))
    : databases;

  async function loadTables(db: string) {
    if (!activeId) return;
    setLoading((prev) => ({ ...prev, [db]: true }));
    try {
      const list = await api.listTables(activeId, db);
      setTables((prev) => ({ ...prev, [db]: list }));
    } catch {
      // 读失败就按空表记下来，免得搜索时的补加载反复重试同一个库
      setTables((prev) => (prev[db] ? prev : { ...prev, [db]: [] }));
    } finally {
      setLoading((prev) => ({ ...prev, [db]: false }));
    }
  }

  async function toggleDb(db: string) {
    const open = !(expanded[db] ?? db === activeDatabase);
    setExpanded((prev) => ({ ...prev, [db]: open }));
    onSelectDatabase(db);
    if (open && !tables[db]) await loadTables(db);
  }

  // 进入工作台时默认选中并展开第一个库，这里补拉它的表（默认展开的库也要有表）
  useEffect(() => {
    if (!activeId || !activeDatabase) return;
    const isOpen = expanded[activeDatabase] ?? true;
    if (isOpen && !tables[activeDatabase] && !loading[activeDatabase]) {
      void loadTables(activeDatabase);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeDatabase, databases, tables, loading]);

  // 搜索时把「库名命中」但还没加载过的库补上，否则按表名搜不到
  useEffect(() => {
    if (!activeId || !query) return;
    const pending = databases
      .filter((db) => dbNameMatches(db) && !tables[db] && !loading[db])
      .slice(0, 12);
    for (const db of pending) void loadTables(db);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, databases, tables, loading, activeId]);

  async function handleRefresh() {
    if (!activeId || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
      const openDbs = databases.filter((db) => expanded[db] ?? db === activeDatabase);
      const fresh: Record<string, TableInfo[]> = {};
      for (const db of openDbs) {
        try {
          fresh[db] = await api.listTables(activeId, db);
        } catch {
          // 忽略单个库的失败，继续刷新其它库
        }
      }
      if (openDbs.length > 0) setTables(fresh);
    } finally {
      setRefreshing(false);
    }
  }

  // 树要虚拟化就得先摊平成「一行一个节点」，缩进在渲染时补
  type TreeRow =
    | { kind: "db"; db: string; open: boolean }
    | { kind: "new"; db: string }
    | { kind: "table"; db: string; table: TableInfo }
    | { kind: "empty"; db: string };

  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    for (const db of visibleDbs) {
      // 搜索时一律展开，方便直接看到命中的表
      const open = query ? true : (expanded[db] ?? db === activeDatabase);
      out.push({ kind: "db", db, open });
      if (!open) continue;
      out.push({ kind: "new", db });
      const list = (tables[db] ?? []).filter(
        (t) => !query || dbNameMatches(db) || tableMatches(t.name),
      );
      for (const t of list) out.push({ kind: "table", db, table: t });
      if (list.length === 0) out.push({ kind: "empty", db });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDbs, query, expanded, activeDatabase, tables, search]);

  const treeScroller = useRef<HTMLDivElement | null>(null);
  const treeVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeScroller.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b px-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索库、表"
            className="h-7 border-0 bg-transparent pr-7 pl-8 text-sm shadow-none focus-visible:ring-0"
          />
          {search && (
            <button
              className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center text-muted-foreground hover:bg-muted"
              onClick={() => setSearch("")}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">数据库</span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">{databases.length}</span>
          {/* Oracle 的 schema 就是用户，要 DBA 建，这里不给入口 */}
          {!isSqlite && flavor !== "oracle" && (
            <button
              title={flavor === "postgres" ? "新建 Schema" : "新建数据库"}
              onClick={() => setCreateDbOpen(true)}
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
            >
              <Plus className="size-3.5" />
            </button>
          )}
          <button
            title="刷新数据库列表"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted disabled:opacity-60"
          >
            {refreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </button>
        </div>
      </div>

      <div ref={treeScroller} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">暂无数据库</p>
        ) : (
          <div className="relative" style={{ height: treeVirtualizer.getTotalSize() }}>
            {treeVirtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              return (
                <div
                  key={vi.index}
                  ref={treeVirtualizer.measureElement}
                  data-index={vi.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                  className={row.kind === "db" ? undefined : "ml-3.5 border-l pl-1.5"}
                >
                  {row.kind === "db" && (
                    <button
                      onClick={() => void toggleDb(row.db)}
                      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] ${
                        activeDatabase === row.db ? "bg-accent font-medium" : "hover:bg-accent/50"
                      }`}
                    >
                      <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${row.open ? "rotate-90" : ""}`} />
                      <Database className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{row.db}</span>
                      {loading[row.db] && <Loader2 className="ml-auto size-3 animate-spin text-muted-foreground" />}
                    </button>
                  )}
                  {row.kind === "new" && (
                    <button
                      onClick={() => onCreateTable(row.db)}
                      className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    >
                      <Plus className="size-3.5" /> 新建表
                    </button>
                  )}
                  {row.kind === "table" && (
                    <div
                      className={`group/table relative flex items-center rounded-md ${
                        activeTable === row.table.name && activeDatabase === row.db ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                      }`}
                    >
                      <button
                        onClick={() => onSelectTable(row.db, row.table.name)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-7 pl-2 text-left text-[13px]"
                      >
                        <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{row.table.name}</span>
                        {openTables.includes(row.table.name) && activeTable !== row.table.name && (
                          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                        )}
                      </button>
                      <button
                        title="在 SQL 编辑器中查询"
                        onClick={() => onQueryTable(row.db, row.table.name)}
                        className="absolute right-1 flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover/table:opacity-100 hover:bg-background hover:text-foreground"
                      >
                        <SquareTerminal className="size-3.5" />
                      </button>
                    </div>
                  )}
                  {row.kind === "empty" && <p className="px-2 py-1 text-xs text-muted-foreground">无表</p>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <CreateDatabaseDialog
        open={createDbOpen}
        onClose={() => setCreateDbOpen(false)}
        onCreated={(n) => {
          toast.success(`已创建 ${n}`);
          void onRefresh();
        }}
      />
    </div>
  );
}
