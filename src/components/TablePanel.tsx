import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  KeyRound,
  ListFilter,
  ListTree,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Table2,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { loadAiProviders } from "@/lib/aiProviders";
import { copyText } from "@/lib/clipboard";
import {
  FORMAT_LABEL,
  exportTableAs,
  quoteIdent,
  saveResultAs,
  type ExportFormat,
} from "@/lib/exporters";
import { formatElapsed } from "@/lib/format";
import { parseTableQuery } from "@/lib/tableQuery";
import { valueToDisplay, valueToText } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app";
import type { BrowsedTable, Change, ColumnInfo, ColumnValue, DbFlavor, Filter, IndexInfo, ResultSet, Value } from "@/lib/types";
import { InsertRowDialog } from "./InsertRowDialog";
import { ImportCsvDialog } from "./ImportCsvDialog";
import { ResultsGrid } from "./ResultsGrid";
import { DdlDialog, type DdlMode } from "./DdlDialog";
import { SqlPanel } from "./SqlPanel";
import { MarkdownMessage } from "./MarkdownMessage";
import { ThinkingBody, ThinkingLine, ThinkingToggle } from "./Thinking";

const PAGE_SIZE = 200;
const MAX_PREVIEW_ROWS = 10_000;

const OPERATORS: { value: string; label: string }[] = [
  { value: "=", label: "等于" },
  { value: "!=", label: "不等于" },
  { value: ">", label: "大于" },
  { value: "<", label: "小于" },
  { value: ">=", label: "大于等于" },
  { value: "<=", label: "小于等于" },
  { value: "like", label: "包含" },
];

/** 字符串字面量：PostgreSQL 的反斜杠是普通字符，只转义单引号 */
const quoteVal = (v: string, flavor?: DbFlavor) =>
  flavor === "postgres"
    ? "'" + v.replace(/'/g, "''") + "'"
    : "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";

/** 取 SQL 里第一个 FROM 的目标（去掉引号和空白并小写）；解析不出来返回 null */
function fromTarget(sql: string): string | null {
  const m = /\bfrom\s+([`"\w$]+(?:\s*\.\s*[`"\w$]+)?)/i.exec(sql);
  return m ? m[1].replace(/[`"\s]/g, "").toLowerCase() : null;
}

function buildDisplaySql(
  database: string,
  table: string,
  filters: Filter[],
  sort: { column: string; dir: "asc" | "desc" } | null,
  flavor?: DbFlavor,
): string {
  const where = filters.map((f) => {
    const like = f.operator.toLowerCase() === "like";
    const op = like ? "LIKE" : f.operator;
    return `${quoteIdent(f.column, flavor)} ${op} ${quoteVal(like ? `%${f.value}%` : f.value, flavor)}`;
  });
  const whereClause = where.length > 0 ? `\nWHERE ${where.join(" AND ")}` : "";
  const orderClause = sort
    ? `\nORDER BY ${quoteIdent(sort.column, flavor)} ${sort.dir === "asc" ? "ASC" : "DESC"}`
    : "";
  // 标识符引号按方言走：MySQL 用反引号，PostgreSQL / SQLite / Oracle 用双引号
  const limit = flavor === "oracle" ? `FETCH FIRST ${PAGE_SIZE} ROWS ONLY` : `LIMIT ${PAGE_SIZE}`;
  return `SELECT *\nFROM ${quoteIdent(database, flavor)}.${quoteIdent(table, flavor)}${whereClause}${orderClause}\n${limit};`;
}

interface Props {
  database: string;
  table: string;
  /** 由 SQL 转换过来的初始筛选/排序（nonce 变化时重新应用） */
  seed?: {
    filters: Filter[];
    sort: { column: string; dir: "asc" | "desc" } | null;
    sql?: string;
    nonce: number;
  };
  /** SQL 查的不是当前表时，交给外面新开一个 tab */
  onOpenTable?: (
    database: string,
    table: string,
    seed?: { filters: Filter[]; sort: { column: string; dir: "asc" | "desc" } | null; sql?: string },
  ) => void;
  /** 把 SQL 交给 AI 助手（解释 / 优化 / 修错） */
  onAskAi?: (prompt: string) => void;
}

/** 一行「修改」暂存：记录定位列、新值、以及提交时用于乐观并发校验的原始值 */
interface StagedUpdate {
  pk: ColumnValue[];
  values: Record<string, string | null>;
  original: Record<string, string | null>;
}

const keyOfPk = (pk: ColumnValue[]) => JSON.stringify(pk);

export function TablePanel({ database, table, seed, onOpenTable, onAskAi }: Props) {
  const activeId = useAppStore((s) => s.activeId);
  const flavor = useAppStore((s) => s.connections.find((c) => c.id === s.activeId)?.flavor);
  const identityKey = `dbdesktop.identity.${activeId ?? ""}.${database}.${table}`;
  const [data, setData] = useState<BrowsedTable | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [sql, setSql] = useState("");
  const [lifted, setLifted] = useState<ResultSet | null>(null);
  /** 最近一次「执行计划」的结果，显示在「执行计划」子标签里 */
  const [plan, setPlan] = useState<ResultSet | null>(null);
  /** AI 分析：null 表示还没结果；配了供应商才会请求 */
  const [planAnalysis, setPlanAnalysis] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  /** 模型的思考过程（DeepSeek 这类会先吐，默认只显示最后一行） */
  const [planReasoning, setPlanReasoning] = useState("");
  const [thinkOpen, setThinkOpen] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  // 有没有可用的供应商只查一次（缓存起来，避免每次执行计划都问一遍）
  const aiReadyRef = useRef<boolean | null>(null);
  // 最近一次分析的 SQL，点「重新分析」时复用
  const planSqlRef = useRef<string | null>(null);
  // 在跑的流式请求 id：用来过滤过期事件
  const planReqRef = useRef<string | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [subTab, setSubTab] = useState("data");

  // ---- 编辑暂存 ----
  // 按「定位列的值」做 key，这样切页 / 改筛选 / 排序后暂存不会错位
  const [edits, setEdits] = useState<Record<string, StagedUpdate>>({});
  const [deleted, setDeleted] = useState<Record<string, ColumnValue[]>>({});
  const [inserted, setInserted] = useState<{ id: string; values: Record<string, string | null> }[]>([]);
  const [editing, setEditing] = useState<{ rowIndex: number; column: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [draftNull, setDraftNull] = useState(false);
  const [saving, setSaving] = useState(false);
  // 提交确认弹窗：SQL 预览 + 这次要执行的改动 + 每条改动对应的表格行（失败时定位用）
  const [confirm, setConfirm] = useState<
    { sql: string[]; changes: Change[]; rows: (number | null)[] } | null
  >(null);
  // 新增行弹窗：index 为 null 表示新开一行，否则是在编辑已暂存的第 index 行
  const [insertOpen, setInsertOpen] = useState<{ index: number | null } | null>(null);
  // 让结果区滚到某一行（新增行 / 提交失败的行）
  const [scrollTarget, setScrollTarget] = useState<{ row: number; nonce: number } | null>(null);
  // 提交失败时定位到的那一行
  const [failedRow, setFailedRow] = useState<number | null>(null);
  // 无主键表：用户手动选定的定位列（空 = 只读）
  const [identityColumns, setIdentityColumns] = useState<string[]>([]);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [identityDraft, setIdentityDraft] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [ddl, setDdl] = useState<{ mode: DdlMode; target?: string } | null>(null);
  const [foreignKeys, setForeignKeys] = useState<Record<string, { table: string; column: string }>>({});
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [tableComment, setTableComment] = useState("");
  // 当前 SQL 结果来自哪张表（取自真正执行的那条语句的 FROM）
  const [liftSource, setLiftSource] = useState<string | null>(null);
  // 已经应用过的 seed，避免同一个 tab 重复套用
  const appliedSeed = useRef<number | null>(null);

  const pendingCount = Object.keys(edits).length + Object.keys(deleted).length + inserted.length;

  async function load(
    p: number,
    f: Filter[] = filters,
    s: { column: string; dir: "asc" | "desc" } | null = sort,
  ) {
    if (!activeId) return;
    setPending(true);
    try {
      setData(
        await api.browseTable(activeId, database, table, p, PAGE_SIZE, s?.column ?? null, s?.dir ?? null, f),
      );
    } catch (e) {
      toast.error("加载表数据失败", { description: String(e), duration: 8000 });
    } finally {
      setPending(false);
    }
  }

  // 「执行计划」的 AI 分析是流式推送的：正文和思考过程分开收，按 request_id 过滤过期事件
  useEffect(() => {
    let alive = true;
    const unlisten: UnlistenFn[] = [];
    // listen() 是异步的：返回前组件就卸载的话要立刻注销，否则监听器会越挂越多
    const keep = (un: UnlistenFn) => {
      if (alive) unlisten.push(un);
      else un();
    };
    void listen<{ request_id: string; kind: "text" | "reasoning"; delta: string }>(
      "ai://plan-chunk",
      (e) => {
        if (e.payload.request_id !== planReqRef.current) return;
        if (e.payload.kind === "reasoning") setPlanReasoning((p) => p + e.payload.delta);
        else setPlanAnalysis((p) => (p ?? "") + e.payload.delta);
      },
    ).then(keep);
    void listen<{ request_id: string; text: string; reasoning: string }>("ai://plan-done", (e) => {
      if (e.payload.request_id !== planReqRef.current) return;
      planReqRef.current = null;
      setPlanReasoning(e.payload.reasoning);
      setPlanAnalysis(e.payload.text);
      setAnalyzing(false);
    }).then(keep);
    void listen<{ request_id: string; message: string }>("ai://plan-error", (e) => {
      if (e.payload.request_id !== planReqRef.current) return;
      planReqRef.current = null;
      setAnalyzing(false);
      setPlanError(e.payload.message);
    }).then(keep);
    return () => {
      alive = false;
      unlisten.forEach((un) => un());
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    // 由 SQL 打开的表 tab 会带一组初始筛选/排序
    const f0 = seed?.filters ?? [];
    const s0 = seed?.sort ?? null;
    appliedSeed.current = seed?.nonce ?? null;
    if (seed?.sql !== undefined) setSql(seed.sql);
    setPage(0);
    setFilters(f0);
    setSort(s0);
    setData(null);
    setLifted(null);
    setLiftSource(null);
    // 恢复之前为这张表选定的定位列（无主键表）
    try {
      const saved = JSON.parse(localStorage.getItem(identityKey) ?? "[]");
      if (Array.isArray(saved) && saved.every((x) => typeof x === "string")) {
        setIdentityColumns(saved);
      }
    } catch {
      setIdentityColumns([]);
    }
    void api.listColumns(activeId, database, table).then(setColumns).catch(() => { });
    api.foreignKeys(activeId, database, table).then((fks) => {
      setForeignKeys(Object.fromEntries(fks.map((f) => [f.column, { table: f.ref_table, column: f.ref_column }])));
    }).catch(() => setForeignKeys({}));
    api.indexes(activeId, database, table).then(setIndexes).catch(() => setIndexes([]));
    api.tableComment(activeId, database, table).then(setTableComment).catch(() => setTableComment(""));
    void load(0, f0, s0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, database, table]);

  // 同一张表的 tab 已经开着，又用 SQL 打开一次：套用新的筛选/排序
  useEffect(() => {
    if (!seed || !activeId) return;
    if (appliedSeed.current === seed.nonce) return;
    appliedSeed.current = seed.nonce;
    if (seed.sql !== undefined) setSql(seed.sql);
    setLifted(null);
    setLiftSource(null);
    setPage(0);
    setFilters(seed.filters);
    setSort(seed.sort);
    toast.info(`已按 SQL 生成 ${seed.filters.length} 条筛选条件`, { duration: 6000 });
    void load(0, seed.filters, seed.sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  function addFilter(f: Filter) {
    const next = [...filters, f];
    setFilters(next);
    setPage(0);
    void load(0, next, sort);
  }

  function removeFilter(index: number) {
    const next = filters.filter((_, i) => i !== index);
    setFilters(next);
    setPage(0);
    void load(0, next, sort);
  }

  function clearFilters() {
    setFilters([]);
    setPage(0);
    void load(0, [], sort);
  }

  function changeSort(next: { column: string; dir: "asc" | "desc" } | null) {
    setSort(next);
    setPage(0);
    void load(0, filters, next);
  }

  function changePage(next: number) {
    setPage(next);
    void load(next);
  }

  // 恢复到刚进入该表的状态：清筛选/排序/分页/SQL，重新加载结构与数据
  async function reset() {
    if (!activeId) return;
    setSubTab("data");
    setFilters([]);
    setSort(null);
    setPage(0);
    setSql("");
    setLifted(null);
    setLiftSource(null);
    setPlan(null);
    setPlanAnalysis(null);
    setPlanError(null);
    setData(null);
    clearStaging();
    void api.listColumns(activeId, database, table).then(setColumns).catch(() => { });
    await load(0, [], null);
  }

  const total = data?.total ?? 0;
  // 预览最多只会加载 MAX_PREVIEW_ROWS 行。分页分母用「实际翻得到的行数」，
  // 不然截断后页码会写成 "9801–10000 / 50000"，翻不动却又像是还有更多。
  const loadedTotal = Math.min(total, MAX_PREVIEW_ROWS);
  const showLifted = !!lifted;
  const columnNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const columnMeta = useMemo(() => {
    const m: Record<string, { dataType: string; rawType: string }> = {};
    for (const c of columns) m[c.name] = { dataType: c.data_type, rawType: c.raw_type };
    return m;
  }, [columns]);
  const primaryKeys = columns.filter((c) => c.primary_key).map((c) => c.name);
  // 有主键就用主键定位；无主键表可以用用户手动选的列定位
  const locateColumns = primaryKeys.length > 0 ? primaryKeys : identityColumns;
  const isEditableTable = locateColumns.length > 0;

  // 当前结果区展示的是哪套数据：表分页数据，或者 SQL 跑出来的结果
  const viewColumns = lifted ? lifted.columns : (data?.columns ?? []);
  const viewColumnNames = useMemo(() => viewColumns.map((c) => c.name), [viewColumns]);
  const viewBaseRows = lifted ? lifted.rows : (data?.rows ?? []);
  // SQL 结果要能按主键定位行才可编辑：结果里必须包含这张表的所有主键列
  const missingPks = useMemo(
    () => (isEditableTable ? locateColumns.filter((pk) => !viewColumnNames.includes(pk)) : []),
    [isEditableTable, locateColumns, viewColumnNames],
  );
  const canEditView = isEditableTable && missingPks.length === 0;
  // SQL 结果还得确认查的就是当前这张表，否则按主键回写会改到别的表的数据
  const liftTargetsThisTable = useMemo(() => {
    if (!liftSource) return false;
    const full = `${database}.${table}`.toLowerCase();
    return liftSource === table.toLowerCase() || liftSource === full;
  }, [liftSource, database, table]);
  const editableNow = lifted ? canEditView && liftTargetsThisTable : canEditView;

  function clearStaging() {
    setEdits({});
    setDeleted({});
    setInserted([]);
    setEditing(null);
    setFailedRow(null);
  }

  function rowPk(rowIndex: number): ColumnValue[] | null {
    if (!editableNow) return null;
    const row = viewBaseRows[rowIndex];
    if (!row) return null;
    return locateColumns.map((pk) => {
      const ci = viewColumnNames.indexOf(pk);
      const raw: Value = ci >= 0 ? row[ci] : { type: "null" };
      return { column: pk, value: valueToText(raw) };
    });
  }

  /** 暂存的改动列表 + 每条改动对应的表格行（提交失败时用它定位到行） */
  function buildChanges(): { changes: Change[]; rows: (number | null)[] } {
    const changes: Change[] = [];
    const rows: (number | null)[] = [];
    // 定位值 → 当前视口里的行号（失败时高亮用；不在当前页的就不高亮）
    const indexByKey = new Map<string, number>();
    viewBaseRows.forEach((_, ri) => {
      const pk = rowPk(ri);
      if (pk) indexByKey.set(keyOfPk(pk), ri);
    });
    for (const [key, edit] of Object.entries(edits)) {
      const columns = Object.keys(edit.values);
      changes.push({
        kind: "update",
        pk: edit.pk,
        values: columns.map((column) => ({ column, value: edit.values[column] })),
        original: columns.map((column) => ({ column, value: edit.original[column] ?? null })),
      });
      rows.push(indexByKey.get(key) ?? null);
    }
    for (const [key, pk] of Object.entries(deleted)) {
      changes.push({ kind: "delete", pk });
      rows.push(indexByKey.get(key) ?? null);
    }
    for (const [i, ins] of inserted.entries()) {
      changes.push({
        kind: "insert",
        values: Object.entries(ins.values).map(([column, value]) => ({ column, value })),
      });
      rows.push(viewBaseRows.length + i);
    }
    return { changes, rows };
  }

  const viewRows = useMemo(() => {
    const base = viewBaseRows.map((r) => r.slice());
    base.forEach((_, ri) => {
      const pk = rowPk(ri);
      if (!pk) return;
      const edit = edits[keyOfPk(pk)];
      if (!edit) return;
      for (const [col, val] of Object.entries(edit.values)) {
        const ci = viewColumnNames.indexOf(col);
        if (ci >= 0) {
          base[ri][ci] = val === null ? { type: "null" } : { type: "str", value: val };
        }
      }
    });
    for (const ins of inserted) {
      base.push(
        viewColumnNames.map((col) => {
          if (!(col in ins.values)) return { type: "default" } as Value;
          const v = ins.values[col];
          return v === null ? ({ type: "null" } as Value) : ({ type: "str", value: v } as Value);
        }),
      );
    }
    return base;
  }, [viewBaseRows, edits, inserted, viewColumnNames]);

  function startEdit(rowIndex: number, column: string) {
    const row = viewRows[rowIndex];
    if (!row) return;
    const ci = viewColumnNames.indexOf(column);
    const raw: Value = ci >= 0 ? row[ci] : { type: "null" };
    setEditing({ rowIndex, column });
    setDraft(valueToText(raw));
    setDraftNull(false);
  }

  // 单元格原始值的编辑态（null = NULL）；新增行没有原始值
  function originalEditValue(rowIndex: number, column: string): string | null {
    if (rowIndex >= viewBaseRows.length) return null;
    const row = viewBaseRows[rowIndex];
    const ci = viewColumnNames.indexOf(column);
    if (!row || ci < 0) return null;
    const raw = row[ci];
    return raw.type === "null" ? null : valueToText(raw);
  }

  function commitEdit() {
    if (!editing) return;
    const { rowIndex, column } = editing;
    const value: string | null = draftNull ? null : draft;
    const baseLen = viewBaseRows.length;
    if (rowIndex < baseLen) {
      const pk = rowPk(rowIndex);
      if (!pk) {
        setEditing(null);
        return;
      }
      const key = keyOfPk(pk);
      const original = originalEditValue(rowIndex, column);
      if (original === value) {
        // 与原值相同：撤销该单元格的暂存
        setEdits((prev) => {
          const next = { ...prev };
          const cur = next[key];
          if (!cur) return next;
          const values = { ...cur.values };
          const orig = { ...cur.original };
          delete values[column];
          delete orig[column];
          if (Object.keys(values).length === 0) delete next[key];
          else next[key] = { ...cur, values, original: orig };
          return next;
        });
      } else {
        setEdits((prev) => {
          const cur = prev[key];
          return {
            ...prev,
            [key]: {
              pk,
              values: { ...(cur?.values ?? {}), [column]: value },
              original: { ...(cur?.original ?? {}), [column]: original },
            },
          };
        });
      }
    } else {
      const insIndex = rowIndex - baseLen;
      setInserted((prev) =>
        prev.map((ins, i) =>
          i === insIndex ? { ...ins, values: { ...ins.values, [column]: value } } : ins,
        ),
      );
    }
    setEditing(null);
  }

  function cancelEdit() {
    setEditing(null);
  }

  // 弹窗「暂存」：与原值相同则撤销该单元格暂存，否则记入
  function stageEdit(rowIndex: number, column: string, value: string | null) {
    const baseLen = viewBaseRows.length;
    if (rowIndex < baseLen) {
      const pk = rowPk(rowIndex);
      if (!pk) return;
      const key = keyOfPk(pk);
      const original = originalEditValue(rowIndex, column);
      if (original === value) {
        setEdits((prev) => {
          const next = { ...prev };
          const cur = next[key];
          if (!cur) return next;
          const values = { ...cur.values };
          const orig = { ...cur.original };
          delete values[column];
          delete orig[column];
          if (Object.keys(values).length === 0) delete next[key];
          else next[key] = { ...cur, values, original: orig };
          return next;
        });
      } else {
        setEdits((prev) => {
          const cur = prev[key];
          return {
            ...prev,
            [key]: {
              pk,
              values: { ...(cur?.values ?? {}), [column]: value },
              original: { ...(cur?.original ?? {}), [column]: original },
            },
          };
        });
      }
    } else {
      const insIndex = rowIndex - baseLen;
      setInserted((prev) =>
        prev.map((ins, i) => (i === insIndex ? { ...ins, values: { ...ins.values, [column]: value } } : ins)),
      );
    }
  }

  function toggleDeleteRow(rowIndex: number) {
    const baseLen = viewBaseRows.length;
    if (rowIndex < baseLen) {
      const pk = rowPk(rowIndex);
      if (!pk) return;
      const key = keyOfPk(pk);
      setDeleted((prev) => {
        const next = { ...prev };
        if (key in next) delete next[key];
        else next[key] = pk;
        return next;
      });
    } else {
      setInserted((prev) => prev.filter((_, i) => i !== rowIndex - baseLen));
    }
  }

  function addRow() {
    setInsertOpen({ index: null });
  }

  function editInsertedRow(rowIndex: number) {
    const baseLen = viewBaseRows.length;
    setInsertOpen({ index: rowIndex - baseLen });
  }

  function confirmInsert(values: Record<string, string | null>) {
    const target = insertOpen;
    if (target && target.index !== null) {
      setInserted((prev) =>
        prev.map((ins, i) => (i === target.index ? { ...ins, values } : ins)),
      );
    } else {
      setInserted((prev) => [...prev, { id: crypto.randomUUID(), values }]);
      setScrollTarget({ row: viewBaseRows.length + inserted.length, nonce: Date.now() });
    }
    setInsertOpen(null);
  }

  function rollback() {
    clearStaging();
  }

  async function exportData(format: ExportFormat) {
    if (!activeId) return;
    try {
      if (lifted) {
        const ref = `${quoteIdent(database, flavor)}.${quoteIdent(table, flavor)}`;
        const p = await saveResultAs(lifted, format, table, ref, flavor);
        if (p) toast.success(`已导出 ${FORMAT_LABEL[format]}`, { description: p });
      } else {
        const r = await exportTableAs(
          activeId,
          database,
          table,
          filters,
          sort,
          format,
          `${table}.${format}`,
        );
        if (r) toast.success(`已导出 ${r.count} 行（${FORMAT_LABEL[format]}）`, { description: r.path });
      }
    } catch (e) {
      toast.error("导出失败", { description: String(e) });
    }
  }

  function reloadAfterDdl() {
    setDdl(null);
    void api.listColumns(activeId!, database, table).then(setColumns).catch(() => { });
    void api.tableComment(activeId!, database, table).then(setTableComment).catch(() => { });
    void api.indexes(activeId!, database, table).then(setIndexes).catch(() => { });
    void load(page, filters, sort);
  }

  /**
   * SQL 结果和表分页数据是两套行序。暂存已经按定位列的值跟踪，切视图不会错位，
   * 所以这里不需要再清暂存——被筛选掉的行只是暂时不显示，切回去还在。
   */
  /** 从「SQL 结果 / 执行计划」切回表分页数据（表数据一直在内存里，不用重新查） */
  function backToTable() {
    setLifted(null);
    setLiftSource(null);
    if (!data) void load(0, filters, sort);
  }

  /** 把执行计划拼成纯文本喂给模型（表格线没必要，竖线分隔就够读） */
  function planToText(r: ResultSet): string {
    const head = r.columns.map((c) => c.name).join(" | ");
    const body = r.rows.map((row) => row.map((v) => valueToDisplay(v)).join(" | "));
    return [head, ...body].join("\n");
  }

  /** 有没有可用的 AI 供应商（没配就整个功能不出现，也不发请求） */
  async function aiConfigured(): Promise<boolean> {
    // 配好了就一直记住；没配好每次重查，用户去设置里补上后回来就能用
    if (aiReadyRef.current !== true) {
      try {
        const all = await loadAiProviders();
        const def = all.providers.find((p) => p.id === all.default_id);
        aiReadyRef.current = !!def && def.token.trim() !== "" && def.default_model.trim() !== "";
      } catch {
        aiReadyRef.current = false;
      }
    }
    if (aiReadyRef.current) setAiReady(true);
    return aiReadyRef.current;
  }

  /** 执行计划下自动跑一次 AI 分析；没配供应商就静默跳过 */
  async function analyzePlan(r: ResultSet, sql: string | null) {
    if (!(await aiConfigured())) return;
    planSqlRef.current = sql;
    const rid = crypto.randomUUID();
    planReqRef.current = rid;
    setAnalyzing(true);
    setPlanError(null);
    setPlanAnalysis(null);
    setPlanReasoning("");
    setThinkOpen(false);
    try {
      await api.aiAnalyzePlanStream({
        requestId: rid,
        connectionId: activeId,
        database,
        table,
        sql,
        plan: planToText(r),
      });
    } catch (e) {
      // 命令级的失败（比如没配供应商）走这里；流式中断走 ai://plan-error
      if (planReqRef.current === rid) setPlanError(String(e));
    } finally {
      // done 事件通常已经先到了；这里兜底，避免「思考中」一直转
      if (planReqRef.current === rid) {
        planReqRef.current = null;
        setAnalyzing(false);
      }
    }
  }

  async function stopAnalysis() {
    const rid = planReqRef.current;
    if (!rid) return;
    try {
      await api.aiCancel(rid);
    } catch {
      // 已经跑完了就没什么可停的
    }
  }

  function handleResultChange(
    r: ResultSet | null,
    e: string | null,
    executed?: string,
    kind: "query" | "explain" = "query",
  ) {
    if (!r) {
      setLiftSource(null);
      setLifted(null);
      if (e) toast.error("SQL 执行失败", { description: e, duration: 8000 });
      return;
    }

    // 执行计划：单独放到「执行计划」子标签里，不参与「转成筛选条件」那套解析
    if (kind === "explain") {
      setPlan(r);
      setSubTab("explain");
      void analyzePlan(r, executed ?? null);
      return;
    }
    const parsed = parseTableQuery(executed ?? "");
    if (parsed.ok) {
      const sameTable =
        parsed.table.toLowerCase() === table.toLowerCase() &&
        (!parsed.database || parsed.database.toLowerCase() === database.toLowerCase());
      if (!sameTable) {
        // 换表了：交给外面新开 tab，当前 tab 保持原样
        const target = parsed.database ?? database;
        setLifted(null);
        setLiftSource(null);
        toast.info(`SQL 查的是 ${target}.${parsed.table}，已在新标签页打开`, { duration: 6000 });
        onOpenTable?.(target, parsed.table, {
          filters: parsed.filters,
          sort: parsed.sort,
          sql: executed,
        });
        return;
      }
      // 同一张表：把 SQL 的条件落到筛选/排序，回到默认那套可编辑视图
      setLifted(null);
      setLiftSource(null);
      setPage(0);
      setFilters(parsed.filters);
      setSort(parsed.sort);
      toast.info(
        `已按 SQL 生成 ${parsed.filters.length} 条筛选条件${parsed.sort ? `、按 ${parsed.sort.column} ${parsed.sort.dir === "asc" ? "升序" : "降序"}` : ""}（分页由表格接管）`,
        { duration: 6000 },
      );
      void load(0, parsed.filters, parsed.sort);
      return;
    }

    // 解析不了的（JOIN / 聚合 / OR 条件等）：退回原样展示结果
    setLiftSource(fromTarget(executed ?? sql));
    setLifted(r);
    toast.warning(`这条 SQL 无法转成筛选条件（${parsed.reason}），下面是原始结果`, { duration: 8000 });
  }

  // 提交前先预览 SQL，用户二次确认
  async function commit() {
    const { changes, rows } = buildChanges();
    if (changes.length === 0) return;
    try {
      const sql = await api.previewChanges(database, table, changes, flavor);
      setConfirm({ sql, changes, rows });
    } catch (e) {
      toast.error("生成 SQL 预览失败", { description: String(e), duration: 8000 });
    }
  }

  async function doCommit() {
    if (!activeId || !confirm) return;
    setSaving(true);
    try {
      const applied = await api.applyChanges(activeId, database, table, confirm.changes);
      setConfirm(null);
      setFailedRow(null);
      clearStaging();
      toast.success(`已提交 ${applied} 条改动`);
      await load(page, filters, sort);
    } catch (e) {
      const message = String(e);
      toast.error("提交失败", { description: message, duration: 8000 });
      setConfirm(null);
      // 错误信息里带「第 N 条改动」，把它映射回表格里的那一行并滚过去
      const m = /第\s*(\d+)\s*条改动/.exec(message);
      const row = m ? confirm.rows[Number(m[1]) - 1] : null;
      if (row !== null && row !== undefined) {
        setFailedRow(row);
        setScrollTarget({ row, nonce: Date.now() });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <Table2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono">{database}.{table}</span>
        {viewColumns.length > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{viewColumns.length} 列</span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Button size="xs" variant="ghost" title="导入 CSV" onClick={() => setImportOpen(true)}>
            <Upload className="size-4" /> 导入
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="ghost" title="导出">
                <Download className="size-4" /> 导出
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void exportData("csv")}>导出为 CSV</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportData("json")}>导出为 JSON</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportData("sql")}>
                导出为 SQL INSERT
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="刷新（重载数据并清空筛选/排序/SQL）"
            disabled={pending}
            onClick={() => void reset()}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </div>

      <Tabs value={subTab} onValueChange={setSubTab} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between border-b px-2">
          <TabsList variant="line" className="gap-0 rounded-none bg-transparent">
            <TabsTrigger value="data" className="gap-1.5 px-2.5">
              <Columns3 className="size-3.5" /> 数据
            </TabsTrigger>
            <TabsTrigger value="structure" className="gap-1.5 px-2.5">
              <KeyRound className="size-3.5" /> 结构
            </TabsTrigger>
            {plan && (
              <TabsTrigger value="explain" className="gap-1.5 px-2.5">
                <ListTree className="size-3.5" /> 执行计划
              </TabsTrigger>
            )}
          </TabsList>
          {subTab === "structure" ? (
            <CopyDdlButton database={database} table={table} />
          ) : subTab === "explain" ? (
            <span className="text-xs text-muted-foreground">结果只读</span>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {!showLifted && total > 0 && (
                <span className="font-mono">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, loadedTotal)} / {loadedTotal}
                </span>
              )}
              {!showLifted && (
                <>
                  <Button variant="ghost" size="icon" className="size-7" disabled={page === 0 || pending} onClick={() => changePage(page - 1)}>
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7" disabled={(page + 1) * PAGE_SIZE >= loadedTotal || pending} onClick={() => changePage(page + 1)}>
                    <ChevronRight className="size-4" />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        <TabsContent value="data" className="flex min-h-0 flex-1 flex-col">
          {!showLifted && !isEditableTable && columns.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
              <span>该表没有主键，默认只读；可以指定定位列来开启编辑（提交时会校验必须恰好影响 1 行）。</span>
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  setIdentityDraft(identityColumns);
                  setIdentityOpen(true);
                }}
              >
                <KeyRound className="size-3" /> 选择定位列
              </Button>
            </div>
          )}
          {!showLifted && primaryKeys.length === 0 && isEditableTable && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-amber-50 px-3 py-1 text-xs text-amber-700">
              <span>
                用 {locateColumns.join(" + ")} 定位行。这几列如果重复，提交会被拒绝（要求恰好影响 1 行）。
              </span>
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  setIdentityDraft(identityColumns);
                  setIdentityOpen(true);
                }}
              >
                重选
              </Button>
            </div>
          )}
          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel className="flex min-h-0 flex-col" style={{ overflow: "hidden" }}>
              {!showLifted && (
                <PreviewToolbar
                  columns={columnNames}
                  filters={filters}
                  sort={sort}
                  onAddFilter={addFilter}
                  onRemoveFilter={removeFilter}
                  onClearFilters={clearFilters}
                  onChangeSort={changeSort}
                  onAddToTerminal={() =>
                    setSql(buildDisplaySql(database, table, filters, sort, flavor))
                  }
                  leftExtra={
                    isEditableTable ? (
                      <Button size="xs" variant="outline" onClick={addRow}>
                        <Plus className="size-3" /> 新增行
                      </Button>
                    ) : undefined
                  }
                  rightExtra={
                    isEditableTable ? (
                      <>
                        <Button size="xs" variant="outline" disabled={pendingCount === 0 || saving} onClick={rollback}>
                          <RotateCcw className="size-3" /> 回滚
                        </Button>
                        <Button size="xs" disabled={pendingCount === 0 || saving} onClick={() => void commit()}>
                          {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} 提交
                        </Button>
                      </>
                    ) : undefined
                  }
                />
              )}
              {!showLifted && data && (
                <div className="flex flex-row justify-between items-center shrink-0 border-b px-3 py-1 text-xs text-muted-foreground">
                  <div>
                    共 {total} 行 · {formatElapsed(data.elapsed_ms)}
                    {total > MAX_PREVIEW_ROWS && " · 已截断，最多展示 10000 行"}
                  </div>
                  <div>
                    {isEditableTable && (
                      <>
                        <StagedCounts
                          modified={Object.keys(edits).length}
                          inserted={inserted.length}
                          deleted={Object.keys(deleted).length}
                        />
                      </>
                    )}
                  </div>

                </div>
              )}
              <div className="flex min-h-0 flex-1 flex-col">
                {lifted && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
                    <span>
                      共 {lifted.rows.length} 行 · {formatElapsed(lifted.elapsed_ms)}
                      {lifted.truncated && " · 已截断，最多展示 10000 行"}
                    </span>
                    {isEditableTable && missingPks.length > 0 && (
                      <span className="text-amber-600">
                        结果缺少主键列 {missingPks.join("、")}，只能查看
                      </span>
                    )}
                    {isEditableTable && missingPks.length === 0 && !liftTargetsThisTable && (
                      <span className="text-amber-600">
                        这条 SQL 查的不是当前表 {database}.{table}，结果只读
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1.5">
                      <Button size="xs" variant="ghost" onClick={backToTable}>
                        <Table2 className="size-3" /> 返回表数据
                      </Button>
                      {editableNow && (
                        <>
                          <StagedCounts
                            modified={Object.keys(edits).length}
                            inserted={inserted.length}
                            deleted={Object.keys(deleted).length}
                          />
                          <Button size="xs" variant="outline" onClick={addRow}>
                            <Plus className="size-3" /> 新增行
                          </Button>
                          <Button size="xs" variant="outline" disabled={pendingCount === 0 || saving} onClick={rollback}>
                            <RotateCcw className="size-3" /> 回滚
                          </Button>
                          <Button size="xs" disabled={pendingCount === 0 || saving} onClick={() => void commit()}>
                            {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} 提交
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                )}
                {lifted || data ? (
                  <ResultsGrid
                    columns={viewColumns}
                    rows={viewRows}
                    empty={lifted ? "查询无结果" : "无数据"}
                    meta={columnMeta}
                    editable={editableNow ? {
                      primaryKeys: locateColumns,
                      canEditCell: (_ri, col) => !locateColumns.includes(col),
                      isDirty: (ri, col) => {
                        const pk = rowPk(ri);
                        return pk ? edits[keyOfPk(pk)]?.values[col] !== undefined : false;
                      },
                      isRowDeleted: (ri) => {
                        const pk = rowPk(ri);
                        return pk ? keyOfPk(pk) in deleted : false;
                      },
                      isRowInserted: (ri) => ri >= viewBaseRows.length,
                      isRowFailed: (ri) => failedRow === ri,
                      onStartEdit: startEdit,
                      onDeleteRow: toggleDeleteRow,
                      onStageEdit: stageEdit,
                      onEditInsertedRow: editInsertedRow,
                    } : undefined}
                    editing={editing}
                    draft={draft}
                    draftNull={draftNull}
                    scrollTarget={scrollTarget}
                    foreignKeys={foreignKeys}
                    onForeignKeyJump={(_column, value, target) => {
                      onOpenTable?.(database, target.table, {
                        filters: [{ column: target.column, operator: "=", value }],
                        sort: null,
                      });
                    }}
                    onDraftChange={setDraft}
                    onDraftNullChange={setDraftNull}
                    onCommitEdit={commitEdit}
                    onCancelEdit={cancelEdit}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
                    {pending ? "加载中…" : "暂无数据"}
                  </div>
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={240}
              groupResizeBehavior="preserve-pixel-size"
              className="flex min-h-0 flex-col"
              style={{ overflow: "hidden" }}
            >
              <SqlPanel
                database={database}
                sql={sql}
                onSqlChange={setSql}
                liftResult
                onAskAi={onAskAi}
                onResultChange={handleResultChange}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </TabsContent>

        <TabsContent value="structure" className="min-h-0 flex-1 overflow-auto">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">表注释</span>
            <span className="truncate">{tableComment || <span className="text-muted-foreground">（无）</span>}</span>
            {flavor !== "sqlite" && (
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() => setDdl({ mode: "table_comment" })}
              >
                编辑注释
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <Button size="xs" variant="outline" onClick={() => setDdl({ mode: "add_column" })}>加列</Button>
            <Button size="xs" variant="outline" onClick={() => setDdl({ mode: "add_index" })}>加索引</Button>
            <Button size="xs" variant="outline" onClick={() => setDdl({ mode: "drop_index" })}>删索引</Button>
            <span className="ml-auto flex gap-2">
              <Button size="xs" variant="outline" onClick={() => setDdl({ mode: "truncate" })}>清空表</Button>
              <Button size="xs" variant="destructive" onClick={() => setDdl({ mode: "drop_table" })}>删除表</Button>
            </span>
          </div>
          <Table className="min-w-max">
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>列名</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>可空</TableHead>
                <TableHead>默认值</TableHead>
                <TableHead>注释</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {columns.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="font-mono font-medium">{c.name}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">{c.raw_type || c.data_type}</TableCell>
                  <TableCell>{c.nullable ? "是" : "否"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.default_value ?? ""}</TableCell>
                  <TableCell className="max-w-60 truncate text-xs text-muted-foreground" title={c.comment}>
                    {c.comment}
                  </TableCell>
                  <TableCell className="text-right">
                    <button className="mr-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setDdl({ mode: "alter_column", target: c.name })}>改</button>
                    <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setDdl({ mode: "drop_column", target: c.name })}>删</button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="border-t px-3 py-1.5 text-xs font-medium text-muted-foreground">索引</div>
          <Table className="min-w-max">
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>名称</TableHead>
                <TableHead>列</TableHead>
                <TableHead>唯一</TableHead>
                <TableHead>主键</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {indexes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-xs text-muted-foreground">（无索引）</TableCell>
                </TableRow>
              ) : (
                indexes.map((ix) => (
                  <TableRow key={ix.name}>
                    <TableCell className="font-mono font-medium">{ix.name}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{ix.columns.join(", ")}</TableCell>
                    <TableCell>{ix.unique ? "是" : "否"}</TableCell>
                    <TableCell>{ix.primary ? "是" : "否"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TabsContent>

        <TabsContent value="explain" className="flex min-h-0 flex-1 flex-col">
          {plan && (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
                <span>
                  共 {plan.rows.length} 行 · {plan.elapsed_ms}ms
                </span>
                {aiReady && (
                  <span className="ml-auto flex items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={analyzing}
                      onClick={() => void analyzePlan(plan, planSqlRef.current)}
                    >
                      <Sparkles className="size-3" /> 重新分析
                    </Button>
                  </span>
                )}
              </div>
              {/* 有 AI 分析时表格只占内容高度（执行计划通常就一两行），其余留给分析结果 */}
              <div
                className={cn(
                  "flex min-h-0 flex-col",
                  aiReady ? "max-h-[40%] shrink-0 overflow-hidden" : "flex-1",
                )}
              >
                <ResultsGrid columns={plan.columns} rows={plan.rows} empty="没有执行计划结果" />
              </div>
              {aiReady && (
                <div className="flex min-h-0 flex-1 flex-col border-t bg-muted/20">
                  <div className="flex h-8 shrink-0 items-center gap-2 px-4 text-xs">
                    <Sparkles className="size-3.5 text-muted-foreground" />
                    <span className="font-medium text-muted-foreground">AI 分析</span>
                    {analyzing && (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> 思考中
                      </span>
                    )}
                    {analyzing ? (
                      <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void stopAnalysis()}>
                        <Square className="size-3" /> 停止
                      </Button>
                    ) : (
                      planReasoning.trim() !== "" && (
                        <ThinkingToggle open={thinkOpen} onToggle={() => setThinkOpen((v) => !v)} className="ml-auto" />
                      )
                    )}
                  </div>
                  {planReasoning.trim() !== "" &&
                    (thinkOpen ? (
                      <ThinkingBody text={planReasoning} className="mx-4 mb-2 shrink-0" />
                    ) : (
                      <ThinkingLine text={planReasoning} className="shrink-0 px-4" />
                    ))}
                  <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
                    {planError ? (
                      <div className="text-sm text-destructive">{planError}</div>
                    ) : planAnalysis ? (
                      <MarkdownMessage content={planAnalysis} onInsertSql={(s) => setSql(s)} />
                    ) : analyzing ? null : (
                      <div className="text-sm text-muted-foreground">没有分析结果</div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>确认执行</DialogTitle>
            <DialogDescription>
              即将执行以下 {confirm?.sql.length ?? 0} 条 SQL，请确认无误：
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {confirm?.sql.join(";\n\n")}
          </pre>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirm(null)}
            >
              取消
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void doCommit()}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} 确认执行
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <InsertRowDialog
        open={!!insertOpen}
        columns={columns}
        initial={insertOpen?.index != null ? inserted[insertOpen.index]?.values : undefined}
        onCancel={() => setInsertOpen(null)}
        onConfirm={confirmInsert}
      />

      <ImportCsvDialog
        open={importOpen}
        connectionId={activeId}
        database={database}
        table={table}
        columns={columns}
        onClose={() => setImportOpen(false)}
        onImported={(report) => {
          if (report.failed > 0) {
            toast.warning(`导入完成：成功 ${report.imported} 行，失败 ${report.failed} 行`, { duration: 8000 });
          } else {
            toast.success(`导入完成：成功 ${report.imported} 行`);
          }
          void load(page, filters, sort);
        }}
      />

      <DdlDialog
        open={!!ddl}
        database={database}
        table={table}
        columns={columns}
        indexes={indexes}
        mode={ddl?.mode ?? "add_column"}
        target={ddl?.target}
        initialComment={tableComment}
        onClose={() => setDdl(null)}
        onExecuted={reloadAfterDdl}
      />

      <Dialog open={identityOpen} onOpenChange={(o) => !o && setIdentityOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>选择定位列</DialogTitle>
            <DialogDescription>
              这张表没有主键。选一组能唯一确定一行的列，才能编辑和删除；提交时每条改动都必须恰好影响 1
              行，否则整批回滚。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
            {columns.map((c) => {
              const on = identityDraft.includes(c.name);
              return (
                <label key={c.name} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/60">
                  <Checkbox
                    checked={on}
                    onCheckedChange={() =>
                      setIdentityDraft((prev) =>
                        prev.includes(c.name) ? prev.filter((n) => n !== c.name) : [...prev, c.name],
                      )
                    }
                  />
                  <span className="font-mono text-xs font-medium">{c.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{c.raw_type}</span>
                  {c.nullable && <span className="text-[10px] text-muted-foreground">可空</span>}
                </label>
              );
            })}
          </div>
          <div className="text-[11px] text-muted-foreground">
            建议选唯一索引列；实在没有就「用全部列」，但那样任何一列不同都会匹配不上。
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setIdentityDraft(columns.map((c) => c.name))}>
              用全部列
            </Button>
            <Button variant="outline" size="sm" onClick={() => setIdentityOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => {
                clearStaging();
                setIdentityColumns(identityDraft);
                if (activeId) {
                  localStorage.setItem(identityKey, JSON.stringify(identityDraft));
                }
                setIdentityOpen(false);
              }}
            >
              确定
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}

/**
 * 暂存改动计数：为 0 时保持低调，大于 0 时给一个淡色药丸。
 * 颜色和表格里高亮一致（修改=琥珀、新增=绿、删除=红），都带深色主题的对应色。
 */
function StagedCounts({
  modified,
  inserted,
  deleted,
}: {
  modified: number;
  inserted: number;
  deleted: number;
}) {
  const parts = [
    {
      key: "modified",
      n: modified,
      label: "处修改",
      tone: "bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    },
    {
      key: "inserted",
      n: inserted,
      label: "新增",
      tone: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    },
    {
      key: "deleted",
      n: deleted,
      label: "删除",
      tone: "bg-red-500/10 text-red-700 dark:bg-red-400/15 dark:text-red-300",
    },
  ];
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {parts.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1">
          {p.key !== "modified" && <span className="text-muted-foreground">·</span>}
          <span className={cn("rounded px-1.5 py-0.5", p.n > 0 ? `font-medium ${p.tone}` : "text-muted-foreground")}>
            {p.n} {p.label}
          </span>
        </span>
      ))}
    </span>
  );
}

function PreviewToolbar({
  columns,
  filters,
  sort,
  onAddFilter,
  onRemoveFilter,
  onClearFilters,
  onChangeSort,
  onAddToTerminal,
  leftExtra,
  rightExtra,
}: {
  columns: string[];
  filters: Filter[];
  sort: { column: string; dir: "asc" | "desc" } | null;
  onAddFilter: (f: Filter) => void;
  onRemoveFilter: (index: number) => void;
  onClearFilters: () => void;
  onChangeSort: (next: { column: string; dir: "asc" | "desc" } | null) => void;
  onAddToTerminal: () => void;
  leftExtra?: ReactNode;
  rightExtra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState("");
  const [operator, setOperator] = useState("=");
  const [value, setValue] = useState("");
  const firstColumn = columns[0] ?? "";

  function submit() {
    const col = column || firstColumn;
    if (!col || value.trim() === "") return;
    onAddFilter({ column: col, operator, value });
    setValue("");
    setOpen(false);
  }

  if (columns.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 pb-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="xs">
            <ListFilter className="size-3" /> 筛选
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-2 p-2">
          <Select value={column || firstColumn} onValueChange={setColumn}>
            <SelectTrigger size="sm" className="w-full"><SelectValue placeholder="选择列" /></SelectTrigger>
            <SelectContent>
              {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex gap-1.5">
            <Select value={operator} onValueChange={setOperator}>
              <SelectTrigger size="sm" className="w-28 shrink-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                {OPERATORS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              value={value}
              placeholder="值"
              className="h-8 text-xs"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <Button size="sm" className="w-full" disabled={value.trim() === ""} onClick={submit}>
            <Plus className="size-3.5" /> 添加条件
          </Button>
        </PopoverContent>
      </Popover>

      <Button variant="outline" size="xs" onClick={onAddToTerminal}>
        <Terminal className="size-3" /> 添加到终端
      </Button>
      {leftExtra}

      {filters.map((f, i) => (
        <span key={`${f.column}-${i}`} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {f.column} {f.operator} {f.value}
          <button className="rounded hover:text-destructive" onClick={() => onRemoveFilter(i)}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      {filters.length > 0 && (
        <Button variant="ghost" size="xs" onClick={onClearFilters}>清除</Button>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <Select
          value={sort?.column ?? ""}
          onValueChange={(c) => onChangeSort({ column: c, dir: sort?.dir ?? "asc" })}
        >
          <SelectTrigger size="sm" className="w-36"><SelectValue placeholder="排序列" /></SelectTrigger>
          <SelectContent>
            {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        {sort && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => onChangeSort({ column: sort.column, dir: sort.dir === "asc" ? "desc" : "asc" })}
            >
              {sort.dir === "asc" ? <ArrowUpNarrowWide className="size-4" /> : <ArrowDownNarrowWide className="size-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="size-8" onClick={() => onChangeSort(null)}>
              <X className="size-4" />
            </Button>
          </>
        )}
        {rightExtra}
      </div>
    </div>
  );
}

function CopyDdlButton({ database, table }: { database: string; table: string }) {
  const activeId = useAppStore((s) => s.activeId);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "err">("idle");

  async function onCopy() {
    if (!activeId) return;
    setState("loading");
    try {
      const ddl = await api.tableDdl(activeId, database, table);
      const ok = await copyText(ddl);
      setState(ok ? "ok" : "err");
    } catch {
      setState("err");
    }
    setTimeout(() => setState("idle"), 1500);
  }

  return (
    <Button variant="outline" size="xs" disabled={state === "loading"} onClick={() => void onCopy()}>
      {state === "loading" ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3" />}
      {state === "ok" ? "已复制" : state === "err" ? "复制失败" : "复制建表语句"}
    </Button>
  );
}
