import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import Editor from "@monaco-editor/react";
import { format as formatSql } from "sql-formatter";
import { toast } from "sonner";
import { Download, FileUp, History, Layers, ListTree, Loader2, MoreHorizontal, Play, PlugZap, Save, Sparkles, Star, Terminal, Trash2, WandSparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { api } from "@/lib/api";
import { formatElapsed } from "@/lib/format";
import { completionSlot, type CompletionSlot } from "@/lib/sqlCompletion";
import { useAppStore } from "@/store/app";
import { addHistory, addSaved, getHistory, getSaved, removeSaved, type HistoryItem, type SavedItem } from "@/lib/sqlStore";
import { parseTableQuery, type ParsedTableQuery } from "@/lib/tableQuery";
import { resolvedTheme } from "@/lib/theme";
import { defineDbDesktopThemes } from "@/lib/monacoThemes";
import { pickSqlFile } from "@/lib/exporters";
import { FORMAT_LABEL, quoteIdent, saveResultAs, type ExportFormat } from "@/lib/exporters";
import type { ResultSet, TableSchema } from "@/lib/types";
import { ResultsGrid } from "./ResultsGrid";

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "BETWEEN",
  "EXISTS", "AS", "DISTINCT", "ALL", "UNION", "UNION ALL", "JOIN", "INNER JOIN",
  "LEFT JOIN", "RIGHT JOIN", "CROSS JOIN", "ON", "USING", "GROUP BY", "ORDER BY",
  "HAVING", "LIMIT", "OFFSET", "INSERT", "INSERT INTO", "UPDATE", "DELETE", "DELETE FROM",
  "SET", "VALUES", "INTO", "CREATE", "CREATE TABLE", "ALTER TABLE", "DROP", "DROP TABLE",
  "TRUNCATE", "TABLE", "VIEW", "INDEX", "PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "DEFAULT",
  "AUTO_INCREMENT", "NOT NULL", "IF EXISTS", "IF NOT EXISTS", "CASE", "WHEN", "THEN",
  "ELSE", "END", "ASC", "DESC", "COUNT", "SUM", "AVG", "MIN", "MAX", "CAST", "CONVERT",
  "COALESCE", "IFNULL", "NOW", "CURRENT_TIMESTAMP", "DATE", "DATETIME", "TIMESTAMP",
  "INT", "BIGINT", "VARCHAR", "TEXT", "CHAR", "DECIMAL", "FLOAT", "DOUBLE", "BOOLEAN",
  "JSON", "BLOB", "WITH", "EXPLAIN", "SHOW", "SHOW TABLES", "SHOW DATABASES", "DESCRIBE",
  "USE", "DATABASE", "SCHEMA", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION",
];

const schemaCache = new Map<string, TableSchema[]>();
let currentSchema: TableSchema[] = [];
let completionRegistered = false;

// 注册 SQL 补全：关键词 + 当前库的表 + 表的字段
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerSqlCompletion(monaco: any) {
  if (completionRegistered) return;
  completionRegistered = true;
  monaco.languages.registerCompletionItemProvider("sql", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideCompletionItems: (model: any, position: any) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const suggestions: any[] = [];
      // 光标落在哪种子句里，决定表还是字段排前面
      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const slot = completionSlot(before);
      // sortText 用 0/1 前缀分组：命中的那一类排前面，同类之间再按名字排
      const rank = (s: CompletionSlot) => (s === slot ? "0" : "1");
      for (const kw of SQL_KEYWORDS) {
        suggestions.push({ label: kw, kind: monaco.languages.CompletionItemKind.Keyword, insertText: kw, sortText: `${rank("keyword")}${kw}`, range });
      }
      for (const table of currentSchema) {
        suggestions.push({ label: table.name, kind: monaco.languages.CompletionItemKind.Struct, insertText: table.name, detail: "表", sortText: `${rank("table")}${table.name}`, range });
        for (const column of table.columns) {
          suggestions.push({ label: column, kind: monaco.languages.CompletionItemKind.Field, insertText: column, detail: table.name, sortText: `${rank("column")}${column}`, range });
        }
      }
      return { suggestions };
    },
  });
}

// 取最后一条非空语句（按分号切分）
function lastStatementText(sql: string): string {
  const parts = sql.split(";").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

// 最后一条非空语句在原文本中的区间（含紧随其后的分号）
function lastStatementRange(value: string): { start: number; end: number } | null {
  let lastStart = -1;
  let lastEnd = -1;
  let idx = 0;
  for (const part of value.split(";")) {
    const start = idx;
    const end = idx + part.length;
    idx = end + 1;
    if (part.trim().length > 0) {
      lastStart = start;
      lastEnd = end;
    }
  }
  if (lastStart < 0) return null;
  const end = value[lastEnd] === ";" ? lastEnd + 1 : lastEnd;
  return { start: lastStart, end };
}

// 光标所在语句的区间（含分号）；落在空白处则回退到最后一条
function statementRangeAt(value: string, offset: number): { start: number; end: number } | null {
  let start = 0;
  for (const part of value.split(";")) {
    const end = start + part.length;
    if (offset <= end) {
      if (part.trim().length === 0) return null;
      return { start, end: value[end] === ";" ? end + 1 : end };
    }
    start = end + 1;
  }
  return lastStatementRange(value);
}

function safeFormat(text: string, language: "mysql" | "sqlite" | "postgresql"): string {
  try {
    return formatSql(text, { language, keywordCase: "upper" });
  } catch {
    return "";
  }
}

interface Props {
  database: string;
  sql: string;
  onSqlChange: (sql: string) => void;
  liftResult?: boolean;
  /**
   * executed = 真正执行的那条语句（多语句时可能是光标/选中的那一条）
   * kind = explain 时说明这是执行计划，结果只读、不该被当成表查询解析
   */
  onResultChange?: (
    result: ResultSet | null,
    error: string | null,
    executed?: string,
    kind?: "query" | "explain",
  ) => void;
  /** 返回 true 表示这次查询由外部接管（例如转成表 tab 打开），这里就不执行了 */
  onTableQuery?: (query: ParsedTableQuery, statement: string) => boolean;
  /** 把一条预设指令丢给 AI 助手（解释 / 优化 / 修错） */
  onAskAi?: (prompt: string) => void;
}

interface ResultTab {
  id: string;
  label: string;
  result: ResultSet | null;
  error: string | null;
  note?: string;
}

export function SqlPanel({
  database,
  sql,
  onSqlChange,
  liftResult = false,
  onResultChange,
  onTableQuery,
  onAskAi,
}: Props) {
  const activeId = useAppStore((s) => s.activeId);
  const flavor = useAppStore((s) => s.connections.find((c) => c.id === s.activeId)?.flavor);
  const theme = useAppStore((s) => s.theme);
  const isDark = resolvedTheme(theme) === "dark";
  const reduce = useReducedMotion() ?? false;
  const [result, setResult] = useState<ResultSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultTabs, setResultTabs] = useState<ResultTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 最近一次真正执行的语句，用来判断结果来自哪张表
  const executedRef = useRef("");
  // 这次结果是不是执行计划（执行计划不该被当成表查询去解析筛选条件）
  const kindRef = useRef<"query" | "explain">("query");
  const [explaining, setExplaining] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveTarget, setSaveTarget] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  function reloadLists() {
    if (!activeId) return;
    const conn = activeId;
    void Promise.all([
      getHistory(conn, database).catch(() => [] as HistoryItem[]),
      getSaved(conn, database).catch(() => [] as SavedItem[]),
    ]).then(([h, s]) => {
      // 期间切了连接/库就丢弃这次结果
      if (conn !== useAppStore.getState().activeId) return;
      setHistory(h);
      setSaved(s);
    });
  }

  /** 记一条历史后再刷新下拉列表（异步入库，失败不打扰用户） */
  function recordHistory(statement: string) {
    if (!activeId) return;
    void addHistory(activeId, database, statement)
      .then(reloadLists)
      .catch(() => {});
  }

  useEffect(() => {
    reloadLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, database]);

  // 拉取当前库的表与字段，供 SQL 自动补全使用
  useEffect(() => {
    if (!activeId || !database) {
      currentSchema = [];
      return;
    }
    const key = `${activeId}:${database}`;
    const cached = schemaCache.get(key);
    if (cached) {
      currentSchema = cached;
      return;
    }
    let cancelled = false;
    void api
      .databaseSchema(activeId, database)
      .then((schema) => {
        schemaCache.set(key, schema);
        if (!cancelled) currentSchema = schema;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId, database]);

  useEffect(() => {
    if (liftResult) onResultChange?.(result, error, executedRef.current, kindRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, error, liftResult]);

  // SQL 被清空时，同步清空结果与错误（手动删空也要清）
  useEffect(() => {
    if (!sql.trim()) {
      setResult(null);
      setError(null);
    }
  }, [sql]);

  // 选中的文本（没有选中则为空串）
  function selectionText(): string {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    const selection = editor?.getSelection?.();
    if (editor && model && selection && !selection.isEmpty()) {
      return model.getValueInRange(selection).trim();
    }
    return "";
  }

  // 当前要操作的语句：有选中则用选中；否则用光标所在语句；再否则用最后一条
  function activeStatement(): string {
    const selected = selectionText();
    if (selected) return selected;
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    const position = editor?.getPosition?.();
    if (model && position) {
      const range = statementRangeAt(model.getValue(), model.getOffsetAt(position));
      if (range) {
        const text = model.getValue().slice(range.start, range.end).trim();
        if (text) return text;
      }
    }
    return lastStatementText(sql);
  }

  const canRun = !!database && sql.trim().length > 0 && !pending;

  function pushResultTab(label: string, r: ResultSet | null, e: string | null) {
    if (liftResult) return;
    const tab: ResultTab = { id: crypto.randomUUID(), label, result: r, error: e };
    setResultTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function pushNoteTab(label: string, note: string) {
    if (liftResult) return;
    const tab: ResultTab = { id: crypto.randomUUID(), label, result: null, error: null, note };
    setResultTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function closeResultTab(id: string) {
    setResultTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      return next;
    });
  }

  async function run() {
    const statement = activeStatement();
    if (!activeId || !database || !statement) return;
    // 单表 SELECT 直接转成表 tab 打开（那边是默认可编辑视图），不在这里出只读结果
    const parsed = parseTableQuery(statement);
    if (parsed.ok && onTableQuery?.(parsed, statement)) {
      recordHistory(statement);
      // 结果由表 tab 负责展示，这里不留旧结果
      setResult(null);
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const r = await api.runSql(activeId, database, statement);
      executedRef.current = statement;
      kindRef.current = "query";
      setResult(r);
      pushResultTab(statement.slice(0, 40) || "查询", r, null);
      recordHistory(statement);
    } catch (e) {
      setError(String(e));
      setResult(null);
      pushResultTab(statement.slice(0, 40) || "查询", null, String(e));
    } finally {
      setPending(false);
    }
  }

  async function runAll() {
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
    if (!activeId || !database || statements.length === 0) return;
    setPending(true);
    setError(null);
    for (const statement of statements) {
      executedRef.current = statement;
      kindRef.current = "query";
      const parsed = parseTableQuery(statement);
      if (parsed.ok && onTableQuery?.(parsed, statement)) {
        recordHistory(statement);
        continue;
      }
      try {
        const r = await api.runSql(activeId, database, statement);
        pushResultTab(statement.slice(0, 40) || "查询", r, null);
        recordHistory(statement);
      } catch (e) {
        pushResultTab(statement.slice(0, 40) || "查询", null, String(e));
      }
    }
    setPending(false);
  }

  async function runFile() {
    if (!activeId || !database) return;
    const path = await pickSqlFile();
    if (!path) return;
    setPending(true);
    setError(null);
    try {
      const report = await api.runSqlFile(activeId, database, path);
      pushNoteTab(`执行文件：${path.split("/").pop() ?? path}`, `执行完成：共 ${report.total} 条，成功 ${report.executed} 条`);
    } catch (e) {
      pushResultTab("执行文件失败", null, String(e));
    } finally {
      setPending(false);
    }
  }

  async function explain() {
    const statement = activeStatement();
    if (!activeId || !statement) return;
    setExplaining(true);
    setError(null);
    try {
      // 前缀由后端按引擎拼（Oracle 要跑 EXPLAIN PLAN + DBMS_XPLAN 两步）
      const r = await api.explainPlan(activeId, database || null, statement);
      // 执行计划的结果只读，别让外层把它当表查询解析筛选条件
      executedRef.current = statement;
      kindRef.current = "explain";
      setResult(r);
      pushResultTab(`执行计划：${statement.slice(0, 30)}`, r, null);
    } catch (e) {
      setError(String(e));
      setResult(null);
      pushResultTab(`执行计划：${statement.slice(0, 30)}`, null, String(e));
    } finally {
      setExplaining(false);
    }
  }

  // 格式化：始终格式化编辑器里的全部 SQL（不管有多少条语句）
  function format() {
    if (!sql.trim()) return;
    const language =
      flavor === "sqlite" ? "sqlite" : flavor === "postgres" ? "postgresql" : "mysql";
    const formatted = safeFormat(sql, language);
    if (formatted) onSqlChange(formatted);
  }

  /** SQL INSERT 导出时的目标表：尽量取最近执行语句里的表，取不到就用占位名 */
  function sqlInsertTableRef(): string {
    const parsed = parseTableQuery(executedRef.current || sql);
    const table = parsed.ok ? parsed.table : "exported_rows";
    const db = (parsed.ok && parsed.database) || database;
    return db ? `${quoteIdent(db, flavor)}.${quoteIdent(table, flavor)}` : quoteIdent(table, flavor);
  }

  /** 快捷指令：把「当前这条语句」（选中优先，否则光标所在）交给 AI 助手 */
  function ask(kind: "解释" | "优化" | "修错") {
    if (!onAskAi) return;
    const statement = activeStatement();
    if (!statement) return;
    const head =
      kind === "解释"
        ? "请解释这条 SQL：它在做什么、涉及哪些表、有没有容易踩的坑。"
        : kind === "优化"
          ? "请看看这条 SQL 有没有性能问题，给出改写建议和需要的索引。"
          : "这条 SQL 执行报错了，请帮我定位原因并给出修正后的写法。";
    const tail = kind === "修错" && error ? `\n\n报错信息：\n${error}` : "";
    onAskAi(`${head}${tail}\n\n\`\`\`sql\n${statement}\n\`\`\``);
  }

  /** 导出当前结果集（前端生成，受结果集 1 万行上限约束） */
  async function exportResult(format: ExportFormat) {
    if (!activeResult) return;
    try {
      const p = await saveResultAs(activeResult, format, "查询结果", sqlInsertTableRef(), flavor);
      if (p) toast.success(`已导出 ${FORMAT_LABEL[format]}`, { description: p });
    } catch (e) {
      toast.error("导出失败", { description: String(e) });
    }
  }

  function clear() {
    onSqlChange("");
    setResult(null);
    setError(null);
    setResultTabs([]);
    setActiveTabId(null);
  }

  function openSave() {
    const statement = activeStatement();
    if (!statement) return;
    setSaveTarget(statement);
    setSaveName("");
    setSaveOpen(true);
  }

  function confirmSave() {
    if (!activeId || !saveName.trim() || !saveTarget) return;
    const conn = activeId;
    void addSaved(conn, database, saveName.trim(), saveTarget)
      .then(reloadLists)
      .catch((e) => toast.error(String(e)));
    setSaveOpen(false);
  }

  const editor = (
    <Editor
      height="100%"
      language="sql"
      value={sql}
      onChange={(v) => onSqlChange(v ?? "")}
      onMount={(ed) => {
        editorRef.current = ed;
      }}
      beforeMount={(monaco) => {
        registerSqlCompletion(monaco);
        defineDbDesktopThemes(monaco);
      }}
      theme={isDark ? "dbdesktop-dark" : "dbdesktop-light"}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        lineNumbersMinChars: 3,
      }}
    />
  );

  const activeTab = resultTabs.find((t) => t.id === activeTabId) ?? null;
  const activeResult = liftResult ? result : (activeTab?.result ?? null);
  const activeError = liftResult ? error : (activeTab?.error ?? null);
  const activeNote = liftResult ? null : (activeTab?.note ?? null);

  const resultArea = (
    <div className="flex min-h-0 flex-1 flex-col">
      {!liftResult && resultTabs.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1">
          {resultTabs.map((t, i) => (
            <button
              key={t.id}
              onClick={() => setActiveTabId(t.id)}
              className={
                "flex max-w-56 shrink-0 items-center gap-1 rounded px-2 py-0.5 font-mono text-xs " +
                (t.id === activeTabId ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")
              }
              title={t.label}
            >
              <span className="truncate">结果 {i + 1}: {t.label}</span>
              <X
                className="size-3 shrink-0 opacity-50 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeResultTab(t.id);
                }}
              />
            </button>
          ))}
          <button
            className="shrink-0 px-1 text-xs text-muted-foreground hover:text-foreground"
            title="关闭全部"
            onClick={() => {
              setResultTabs([]);
              setActiveTabId(null);
            }}
          >
            关闭全部
          </button>
        </div>
      )}
      {activeError && (
        <div className="shrink-0 border-b border-red-300 bg-red-50 px-3 py-2 font-mono text-xs [overflow-wrap:anywhere] text-red-600">
          {activeError}
        </div>
      )}
      {activeNote && (
        <div className="shrink-0 border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground">{activeNote}</div>
      )}
      {activeResult && (
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-1 text-xs text-muted-foreground">
          <span>
            共 {activeResult.rows.length} 行 · {formatElapsed(activeResult.elapsed_ms)}
            {activeResult.truncated && " · 已截断，最多展示 10000 行"}
            {" · "}
            <span className="text-amber-600">SQL 结果只读，要改数据请双击左侧的表</span>
          </span>
          {!liftResult && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="ghost">
                  <Download className="size-3.5" /> 导出
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void exportResult("csv")}>导出为 CSV</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportResult("json")}>导出为 JSON</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportResult("sql")}>
                  导出为 SQL INSERT
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {activeResult ? (
        <motion.div
          key={activeTabId ?? "result"}
          className="flex min-h-0 flex-1 flex-col"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.15, ease: "easeOut" }}
        >
          <ResultsGrid columns={activeResult.columns} rows={activeResult.rows} empty="查询无结果" />
        </motion.div>
      ) : activeError || activeNote ? null : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          运行一条 SQL 后，结果会显示在这里
        </div>
      )}
    </div>
  );

  // ⋯ 里两个子菜单的展开状态：Radix 默认只认悬停，这里显式控制成「点击/悬停都能开」
  const [openSub, setOpenSub] = useState<"history" | "saved" | null>(null);
  const toolbar = (
    // 一行只留「上下文 + 常用操作 + 运行」，其余收进 ⋯；
    // 左侧上下文可收缩，免得窗口变窄时把「运行」挤出可视区
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
      <Terminal className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium">SQL 查询</span>
      {database ? (
        <span className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{database}</span>
      ) : (
        <span className="truncate text-xs text-muted-foreground">未选择数据库</span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* 快捷指令：把当前这条语句（选中优先、否则光标所在）交给 AI 助手 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" disabled={!canRun}>
              <Sparkles className="size-3" /> AI
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuItem className="whitespace-nowrap" onSelect={() => ask("解释")}>
              <ListTree className="size-4" /> 解释这条 SQL
            </DropdownMenuItem>
            <DropdownMenuItem className="whitespace-nowrap" onSelect={() => ask("优化")}>
              <WandSparkles className="size-4" /> 优化建议（含索引）
            </DropdownMenuItem>
            <DropdownMenuItem className="whitespace-nowrap" onSelect={() => ask("修错")}>
              <PlugZap className="size-4" /> 帮我修错
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="xs" onClick={format} disabled={!sql.trim()}>
          <WandSparkles className="size-3" /> 格式化
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void explain()} disabled={!canRun || explaining}>
          {explaining ? <Loader2 className="size-3.5 animate-spin" /> : <ListTree className="size-3" />} 执行计划
        </Button>

        {/* 低频 / 管理类操作都收进来 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="更多">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuSub
              open={openSub === "history"}
              onOpenChange={(o) => setOpenSub(o ? "history" : null)}
            >
              {/* Radix 的子菜单默认只响应悬停，这里显式支持点击；也不做禁用，
                  没有历史时在菜单里显示空态，否则用户点了会以为坏了 */}
              <DropdownMenuSubTrigger
                onClick={() => setOpenSub("history")}
                onPointerEnter={() => setOpenSub("history")}
              >
                <History className="size-4" /> 历史记录
                {history.length > 0 && (
                  <span className="rounded bg-muted px-1 text-[10px]">{history.length}</span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-80 overflow-auto">
                <DropdownMenuLabel>最近执行</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {history.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无历史记录</div>
                ) : (
                  history.map((h) => (
                    <DropdownMenuItem key={h.id} className="font-mono text-xs" onClick={() => onSqlChange(h.sql)}>
                      <span className="truncate">{h.sql.replace(/\s+/g, " ")}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub
              open={openSub === "saved"}
              onOpenChange={(o) => setOpenSub(o ? "saved" : null)}
            >
              <DropdownMenuSubTrigger
                onClick={() => setOpenSub("saved")}
                onPointerEnter={() => setOpenSub("saved")}
              >
                <Star className="size-4" /> 收藏记录
                {saved.length > 0 && (
                  <span className="rounded bg-muted px-1 text-[10px]">{saved.length}</span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-80 overflow-auto">
                <DropdownMenuLabel>已收藏</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {saved.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无收藏</div>
                ) : (
                  saved.map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      className="group flex items-center gap-2 text-xs"
                      onClick={() => onSqlChange(s.sql)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{s.name}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {s.sql.replace(/\s+/g, " ")}
                        </span>
                      </span>
                      <button
                        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (activeId) {
                            void removeSaved(s.id)
                              .then(reloadLists)
                              .catch((e) => toast.error(String(e)));
                          }
                        }}
                      >
                        <X className="size-3.5" />
                      </button>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!sql.trim()} onSelect={openSave}>
              <Save className="size-4" /> 收藏当前 SQL
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!sql && !result && !error && resultTabs.length === 0}
              onSelect={clear}
            >
              <Trash2 className="size-4" /> 清空
            </DropdownMenuItem>
            {!liftResult && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!canRun} onSelect={() => void runAll()}>
                  <Layers className="size-4" /> 运行全部
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!database} onSelect={() => void runFile()}>
                  <FileUp className="size-4" /> 执行文件
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button size="xs" onClick={() => void run()} disabled={!canRun}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3" />} 运行
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {liftResult ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {toolbar}
          <div className="min-h-0 flex-1">{editor}</div>
        </div>
      ) : (
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel className="flex min-h-0 flex-col" style={{ overflow: "hidden" }}>
            {resultArea}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            defaultSize={240}
            groupResizeBehavior="preserve-pixel-size"
            className="flex min-h-0 flex-col"
            style={{ overflow: "hidden" }}
          >
            {toolbar}
            <div className="min-h-0 flex-1">{editor}</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>收藏 SQL</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              autoFocus
              placeholder="给这条查询起个名字"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmSave();
                }
              }}
            />
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">
              {saveTarget}
            </pre>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setSaveOpen(false)}>取消</Button>
            <Button size="sm" onClick={confirmSave} disabled={!saveName.trim()}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
