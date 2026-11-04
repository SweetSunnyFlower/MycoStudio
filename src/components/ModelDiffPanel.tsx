import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckSquare,
  ClipboardCopy,
  Download,
  EyeOff,
  Loader2,
  Play,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { ensureExtension } from "@/lib/graphImage";
import { changesToSql, dialectOf, type Dialect } from "@/lib/alterSql";
import { splitStatements } from "@/lib/sqlStatements";
import { diffModels, diffToChanges, type ModelChange } from "@/lib/modelDiff";
import { loadDiffState, saveDiffState } from "@/lib/diffNotes";
import { cn } from "@/lib/utils";
import type { DbFlavor, SchemaGraph } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 现状：一般是从数据库反向工程出来的模型 */
  base: SchemaGraph;
  /** 期望：一般是 PDM 设计文件 */
  target: SchemaGraph;
  baseLabel: string;
  targetLabel: string;
  flavor?: DbFlavor;
  /** 有值就把「已勾选 / 已忽略」的状态落库，下次打开同一对模型还能接着看 */
  scopeKey?: string;
  /** 传了连接和库就能一键把脚本执行过去 */
  connectionId?: string | null;
  database?: string;
}

const KIND_LABEL: Record<ModelChange["kind"], string> = {
  table_added: "新建表",
  table_removed: "删表",
  column_added: "加字段",
  column_removed: "删字段",
  column_changed: "改字段",
  index_added: "加索引",
  index_removed: "删索引",
  index_changed: "改索引",
  fk_added: "加外键",
  fk_removed: "删外键",
  comment_changed: "改表注释",
};

export function ModelDiffPanel({
  open,
  onClose,
  base,
  target,
  baseLabel,
  targetLabel,
  flavor,
  scopeKey,
  connectionId,
  database,
}: Props) {
  const dialect: Dialect = dialectOf(flavor);
  const diff = useMemo(() => diffModels(base, target), [base, target]);
  const changes = useMemo(() => diffToChanges(diff), [diff]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  // 打开时先读回上次的确认状态；没有就默认勾选「安全」的改动
  // （删表 / 删列这类破坏性的留给用户自己决定）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const saved = scopeKey ? await loadDiffState(scopeKey) : null;
      if (cancelled) return;
      if (saved) {
        const ids = new Set(changes.map((c) => c.id));
        setChecked(new Set(saved.checked.filter((id) => ids.has(id))));
        setIgnored(new Set(saved.ignored.filter((id) => ids.has(id))));
        setSavedHint(
          saved.savedAt ? `已恢复上次的确认状态（${new Date(saved.savedAt).toLocaleString()}）` : null,
        );
      } else {
        setChecked(new Set(changes.filter((c) => !c.destructive).map((c) => c.id)));
        setIgnored(new Set());
        setSavedHint(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, changes, scopeKey]);

  // 勾选 / 忽略变化就落库（防抖，别每点一下写一次）
  useEffect(() => {
    if (!open || !scopeKey) return;
    const timer = window.setTimeout(() => {
      void saveDiffState(scopeKey, [...checked], [...ignored]).catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [open, scopeKey, checked, ignored]);

  const sql = useMemo(
    () => changesToSql(changes.filter((c) => checked.has(c.id) && !ignored.has(c.id)), dialect, target.tables),
    [changes, checked, ignored, dialect, target.tables],
  );

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        setIgnored((ig) => {
          const n = new Set(ig);
          n.delete(id);
          return n;
        });
      }
      return next;
    });
  }

  function toggleIgnore(id: string) {
    setIgnored((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        setChecked((ck) => {
          const n = new Set(ck);
          n.delete(id);
          return n;
        });
      }
      return next;
    });
  }

  /** 把勾选的改动逐条执行到库上（DDL 各家都是自动提交，失败即停并报第几条） */
  async function execute() {
    if (!connectionId || !database || !sql.trim()) return;
    const statements = splitStatements(sql);
    setExecuting(true);
    let done = 0;
    try {
      for (const statement of statements) {
        // Oracle 不接受单条语句末尾的分号（MySQL / PG 会容忍），执行前统一去掉
        await api.runSql(connectionId, database, statement.replace(/;\s*$/, ""));
        done += 1;
      }
      toast.success(`已执行 ${done} 条语句`);
    } catch (e) {
      toast.error(`第 ${done + 1} 条执行失败`, { description: String(e), duration: 12000 });
    } finally {
      setExecuting(false);
    }
  }

  async function saveSql() {
    const picked = await save({
      defaultPath: "model-diff.sql",
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!picked) return;
    await api.writeTextFile(ensureExtension(picked, "sql"), sql);
    toast.success("已导出 ALTER 脚本");
  }

  /** 执行前二次确认：说清楚条数与破坏性改动数量 */
  function confirmExecute() {
    const statements = splitStatements(sql);
    const chosen = changes.filter((c) => checked.has(c.id) && !ignored.has(c.id));
    const destructive = chosen.filter((c) => c.destructive).length;
    toast.warning(`即将在 ${database} 上执行 ${statements.length} 条 DDL`, {
      description: destructive > 0 ? `其中包含 ${destructive} 条破坏性改动（删表 / 删列 / 删索引）` : undefined,
      duration: 15000,
      action: { label: "确认执行", onClick: () => void execute() },
      cancel: { label: "取消", onClick: () => {} },
    });
  }

  const empty = diff.summary.added + diff.summary.removed + diff.summary.changed === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[86vh] flex-col gap-3 sm:max-w-5xl [&>button]:hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            模型对比
            <span className="text-xs font-normal text-muted-foreground">
              {baseLabel}（现状） → {targetLabel}（期望）
            </span>
            <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            新建 {diff.summary.added} 张表 · 库里多出 {diff.summary.removed} 张 · 有差异 {diff.summary.changed} 张 ·
            完全一致 {diff.summary.same} 张（字段改动 {diff.counts.columns}、索引 {diff.counts.indexes}、外键{" "}
            {diff.counts.foreignKeys}）
          </p>
        </DialogHeader>

        {empty ? (
          <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
            两个模型完全一致，没有要执行的改动 🎉
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
            {/* 左：改动清单（可勾选） */}
            <div className="flex min-h-0 flex-col rounded-md border">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs text-muted-foreground">
                <span>按需勾选要执行的改动（默认只勾新增类）</span>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() =>
                    setChecked(
                      checked.size === changes.length ? new Set() : new Set(changes.map((c) => c.id)),
                    )
                  }
                >
                  {checked.size === changes.length ? "全不选" : "全选"}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                {changes.map((c) => {
                  const off = ignored.has(c.id);
                  const on = checked.has(c.id) && !off;
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "group flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                        on && "bg-muted/60",
                        off && "opacity-50",
                      )}
                    >
                      <button className="mt-0.5 shrink-0" onClick={() => toggle(c.id)} title="勾选：生成并执行">
                        {on ? (
                          <CheckSquare className="size-3.5 text-primary" />
                        ) : (
                          <Square className="size-3.5 text-muted-foreground" />
                        )}
                      </button>
                      <span className={cn("min-w-0 flex-1", off && "line-through")}>
                        <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {KIND_LABEL[c.kind]}
                        </span>
                        <span className="break-all">{c.label}</span>
                      </span>
                      {c.destructive && (
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                      )}
                      <button
                        className="mt-0.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                        title={off ? "取消忽略" : "忽略这条（不再关心，不生成语句）"}
                        onClick={() => toggleIgnore(c.id)}
                      >
                        <EyeOff className="size-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 右：SQL 预览 */}
            <div className="flex min-h-0 flex-col rounded-md border">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs text-muted-foreground">
                <span>将执行的 SQL（{dialect}）</span>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  disabled={!sql.trim()}
                  onClick={() => void copyText(sql).then(() => toast.success("已复制"))}
                >
                  <ClipboardCopy className="size-3.5" /> 复制
                </Button>
                <Button size="xs" variant="ghost" disabled={!sql.trim()} onClick={() => void saveSql()}>
                  <Download className="size-3.5" /> 另存为
                </Button>
                {connectionId && database && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!sql.trim() || executing}
                    onClick={() => confirmExecute()}
                  >
                    {executing ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    执行到库
                  </Button>
                )}
              </div>
              <pre className="min-h-0 flex-1 overflow-auto bg-muted/20 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {sql.trim() || "-- 没有勾选任何改动"}
              </pre>
            </div>
          </div>
        )}

        <div className="shrink-0 text-xs text-muted-foreground">
          提示：脚本只生成、不自动执行。删表 / 删列 / 删索引这些破坏性改动默认不勾选，确认无影响再手动勾上。
          {savedHint && <span className="ml-2 text-primary/80">{savedHint}</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
