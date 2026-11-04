import { useLayoutEffect, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Loader2, Plus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { DbFlavor } from "@/lib/types";
import { defaultOptions, formatDefault } from "@/lib/sqlDefault";
import { COLUMN_TYPES, ORACLE_TYPES, TypeCombobox } from "./TypeCombobox";

function newColumn(): Col {
  return { name: "id", type: "INT", nullable: false, defaultValue: "", pk: true, autoIncrement: true };
}

interface Col {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
  pk: boolean;
  autoIncrement: boolean;
}

interface Id {
  name: string;
  unique: boolean;
  columns: string[];
}

function quote(name: string, flavor?: DbFlavor) {
  const q = flavor === "sqlite" || flavor === "postgres" || flavor === "oracle" ? '"' : "`";
  return q + name.replace(new RegExp(q, "g"), q + q) + q;
}

function quoteStr(s: string) {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/** 常用字符集及其排序规则（只是候选，都能手输） */
const CHARSETS = ["utf8mb4", "utf8", "gbk", "gb18030", "big5", "latin1", "ascii"];

const COLLATIONS: Record<string, string[]> = {
  utf8mb4: ["utf8mb4_0900_ai_ci", "utf8mb4_general_ci", "utf8mb4_unicode_ci", "utf8mb4_bin", "utf8mb4_0900_as_cs"],
  utf8: ["utf8_general_ci", "utf8_unicode_ci", "utf8_bin"],
  gbk: ["gbk_chinese_ci", "gbk_bin"],
  gb18030: ["gb18030_chinese_ci", "gb18030_bin"],
  big5: ["big5_chinese_ci", "big5_bin"],
  latin1: ["latin1_swedish_ci", "latin1_general_ci", "latin1_bin"],
  ascii: ["ascii_general_ci", "ascii_bin"],
};

export function CreateTableDialog({
  open,
  database,
  onClose,
  onCreated,
}: {
  open: boolean;
  database: string;
  onClose: () => void;
  onCreated: (table: string) => void;
}) {
  const activeId = useAppStore((s) => s.activeId);
  const flavor = useAppStore((s) => s.connections.find((c) => c.id === s.activeId)?.flavor);
  // 类型候选跟着引擎走；两个都能手输
  const columnTypes = flavor === "oracle" ? ORACLE_TYPES : COLUMN_TYPES;
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [charset, setCharset] = useState("");
  const [collation, setCollation] = useState("");
  const [cols, setCols] = useState<Col[]>([newColumn()]);
  const [indexes, setIndexes] = useState<Id[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 拖动调整列顺序（用 Pointer 事件自己实现，HTML5 drag 在 WKWebView 里不可靠）
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);

  // 每次打开都重置：这个组件是常驻的（靠 open 控制显隐），
  // 不重置的话换个库再打开会把上一次没提交的内容带过来
  useLayoutEffect(() => {
    if (!open) return;
    setName("");
    setComment("");
    setCharset("");
    setCollation("");
    setCols([newColumn()]);
    setIndexes([]);
    setError(null);
    setBusy(false);
    setDragIndex(null);
    dragRef.current = null;
  }, [open, database]);

  function update(i: number, patch: Partial<Col>) {
    setCols((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  function moveRow(from: number, to: number) {
    if (from === to || to < 0) return;
    setCols((prev) => {
      if (to >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function updateIndex(i: number, patch: Partial<Id>) {
    setIndexes((prev) => prev.map((ix, idx) => (idx === i ? { ...ix, ...patch } : ix)));
  }

  function startDrag(e: React.PointerEvent<HTMLElement>, i: number) {
    e.preventDefault();
    dragRef.current = i;
    setDragIndex(i);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent<HTMLElement>) {
    const from = dragRef.current;
    if (from === null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tr = el?.closest("tr[data-row-index]") as HTMLElement | null;
    if (!tr) return;
    const to = Number(tr.dataset.rowIndex);
    if (Number.isNaN(to) || to === from) return;
    moveRow(from, to);
    dragRef.current = to;
    setDragIndex(to);
  }

  function endDrag(e: React.PointerEvent<HTMLElement>) {
    dragRef.current = null;
    setDragIndex(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  const statements = (() => {
    const isPg = flavor === "postgres";
    const isOracle = flavor === "oracle";
    const defs = cols
      .filter((c) => c.name.trim())
      .map((c) => {
        // 12c+ 的自增列两种引擎写法不同，SQLite 用 INTEGER PRIMARY KEY
        const identity =
          (isPg || isOracle) && c.autoIncrement ? " GENERATED BY DEFAULT AS IDENTITY" : "";
        const autoInc = !isPg && !isOracle && c.autoIncrement && flavor !== "sqlite" ? " AUTO_INCREMENT" : "";
        const nn = c.nullable && !c.pk ? "" : " NOT NULL";
        const fmt = formatDefault(c.type, c.defaultValue);
        const def = fmt && !((isPg || isOracle) && c.autoIncrement) ? ` DEFAULT ${fmt}` : "";
        return `${quote(c.name, flavor)} ${c.type}${identity}${nn}${def}${autoInc}`;
      });
    const pks = cols.filter((c) => c.pk && c.name.trim()).map((c) => quote(c.name, flavor));
    const existing = cols.map((c) => c.name.trim()).filter(Boolean);
    const indexDefs = indexes
      .map((ix) => ({ ...ix, columns: ix.columns.filter((c) => existing.includes(c)) }))
      .filter((ix) => ix.columns.length > 0);

    const parts = [...defs];
    if (pks.length > 0) parts.push(`PRIMARY KEY (${pks.join(", ")})`);
    // MySQL 的索引可以直接写在建表语句里；PostgreSQL / SQLite / Oracle 要建完表后单独建
    if (flavor !== "sqlite" && !isPg && !isOracle) {
      for (const ix of indexDefs) {
        const indexName = ix.name.trim() ? ` ${quote(ix.name.trim(), flavor)}` : "";
        parts.push(
          `${ix.unique ? "UNIQUE " : ""}INDEX${indexName} (${ix.columns.map((c) => quote(c, flavor)).join(", ")})`,
        );
      }
    }

    const commentClause =
      comment && flavor !== "sqlite" && !isPg && !isOracle ? ` COMMENT=${quoteStr(comment)}` : "";
    const charsetClause =
      flavor !== "sqlite" && !isPg && !isOracle && charset.trim() ? ` DEFAULT CHARSET=${charset.trim()}` : "";
    const collateClause =
      flavor !== "sqlite" && !isPg && !isOracle && collation.trim() ? ` COLLATE=${collation.trim()}` : "";
    const createSql = `CREATE TABLE ${quote(database, flavor)}.${quote(name, flavor)} (\n  ${parts.join(",\n  ")}\n)${charsetClause}${collateClause}${commentClause}`;

    const out = [createSql];
    // PostgreSQL / SQLite / Oracle 都不支持在建表语句里写 INDEX，只能建完表再单独建
    if (flavor === "sqlite" || isPg || isOracle) {
      for (const ix of indexDefs) {
        const indexName = quote(ix.name.trim() || `idx_${name.trim()}_${ix.columns.join("_")}`, flavor);
        const onTable = isPg || isOracle
          ? `${quote(database, flavor)}.${quote(name.trim(), flavor)}`
          : quote(name.trim(), flavor);
        out.push(
          `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${indexName} ON ${onTable} (${ix.columns
            .map((c) => quote(c, flavor))
            .join(", ")})`,
        );
      }
    }
    // PostgreSQL / Oracle 的表注释是独立语句
    if ((isPg || isOracle) && comment) {
      out.push(
        `COMMENT ON TABLE ${quote(database, flavor)}.${quote(name.trim(), flavor)} IS ${quoteStr(comment)}`,
      );
    }
    return out;
  })();

  async function run() {
    if (!activeId || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      for (const statement of statements) {
        await api.runSql(activeId, database, statement);
      }
      onCreated(name.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建表</DialogTitle>
          <DialogDescription>在 {database} 下创建一张表</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <Label>表名</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
          </div>
          <div className="grid gap-1.5">
            <Label>字符集（可选）</Label>
            <TypeCombobox
              value={charset}
              onChange={(v) => {
                setCharset(v);
                // 换字符集时，把不属于新字符集的排序规则清掉
                if (collation && !(COLLATIONS[v.trim().toLowerCase()] ?? []).includes(collation)) {
                  setCollation("");
                }
              }}
              options={CHARSETS}
              disabled={flavor === "sqlite" || flavor === "postgres" || flavor === "oracle"}
              placeholder={
                flavor === "sqlite"
                  ? "SQLite 不支持字符集"
                  : flavor === "postgres"
                    ? "PostgreSQL 不支持字符集"
                    : flavor === "oracle"
                      ? "Oracle 用库的字符集"
                    : "默认"
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label>排序规则（可选）</Label>
            <TypeCombobox
              value={collation}
              onChange={setCollation}
              options={COLLATIONS[charset.trim().toLowerCase()] ?? []}
              disabled={flavor === "sqlite" || flavor === "postgres" || flavor === "oracle"}
              placeholder={
                flavor === "sqlite"
                  ? "SQLite 不支持排序规则"
                  : flavor === "postgres"
                    ? "PostgreSQL 不支持排序规则"
                    : flavor === "oracle"
                      ? "Oracle 不支持指定排序规则"
                    : "默认"
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label>表注释（可选）</Label>
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={flavor === "sqlite"}
              placeholder={flavor === "sqlite" ? "SQLite 不支持表注释" : "这张表是干什么的"}
            />
          </div>
        </div>
        <div className="max-h-64 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="h-9 w-14" />
                <th className="h-9 w-[21%] px-2 text-left whitespace-nowrap">列名</th>
                <th className="h-9 w-[24%] px-2 text-left whitespace-nowrap">类型</th>
                <th className="h-9 w-[11%] whitespace-nowrap">可空</th>
                <th className="h-9 w-[11%] whitespace-nowrap">主键</th>
                <th className="h-9 w-[11%] whitespace-nowrap">自增</th>
                <th className="h-9 w-[16%] px-2 text-left whitespace-nowrap">默认值</th>
                <th className="h-9 w-8" />
              </tr>
            </thead>
            <tbody>
              {cols.map((c, i) => (
                <tr
                  key={i}
                  data-row-index={i}
                  className={"border-t" + (dragIndex === i ? " bg-accent/60" : "")}
                >
                  <td className="p-1">
                    <div className="flex items-center justify-center gap-0.5">
                      <span
                        onPointerDown={(e) => startDrag(e, i)}
                        onPointerMove={onDragMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        title="按住拖动调整列顺序"
                        className="flex cursor-grab touch-none items-center px-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="size-3.5" />
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5 text-muted-foreground"
                        title="上移"
                        disabled={i === 0}
                        onClick={() => moveRow(i, i - 1)}
                      >
                        <ChevronUp className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5 text-muted-foreground"
                        title="下移"
                        disabled={i === cols.length - 1}
                        onClick={() => moveRow(i, i + 1)}
                      >
                        <ChevronDown className="size-3" />
                      </Button>
                    </div>
                  </td>
                  <td className="p-1"><Input className="h-7" value={c.name} onChange={(e) => update(i, { name: e.target.value })} /></td>
                  <td className="p-1">
                    <TypeCombobox
                      value={c.type}
                      onChange={(v) => update(i, { type: v })}
                      options={columnTypes}
                      className="[&_input]:h-7"
                    />
                  </td>
                  <td className="p-1 text-center">
                    <label className="flex cursor-pointer items-center justify-center py-1">
                      <Checkbox
                        checked={c.nullable}
                        onCheckedChange={(v) => update(i, { nullable: v === true })}
                      />
                    </label>
                  </td>
                  <td className="p-1 text-center">
                    <label className="flex cursor-pointer items-center justify-center py-1">
                      <Checkbox
                        checked={c.pk}
                        onCheckedChange={(v) => update(i, { pk: v === true, nullable: false })}
                      />
                    </label>
                  </td>
                  <td className="p-1 text-center">
                    <label className="flex cursor-pointer items-center justify-center py-1">
                      <Checkbox
                        disabled={flavor === "sqlite"}
                        checked={c.autoIncrement}
                        onCheckedChange={(v) => update(i, { autoIncrement: v === true })}
                      />
                    </label>
                  </td>
                  <td className="p-1">
                    <TypeCombobox
                      value={c.defaultValue}
                      onChange={(v) => update(i, { defaultValue: v })}
                      options={defaultOptions(c.type, flavor)}
                      placeholder="默认值"
                      className="[&_input]:h-7"
                    />
                  </td>
                  <td className="p-1 text-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-destructive"
                      title="删除这一列"
                      onClick={() => setCols((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button size="sm" variant="outline" className="w-fit" onClick={() => setCols((prev) => [...prev, { name: "", type: "VARCHAR(255)", nullable: true, defaultValue: "", pk: false, autoIncrement: false }])}>
          <Plus className="size-3.5" /> 加一列
        </Button>

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">索引</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIndexes((prev) => [...prev, { name: "", unique: false, columns: [] }])}
            >
              <Plus className="size-3.5" /> 加索引
            </Button>
          </div>
          {indexes.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有索引。主键不用在这里建，勾选「主键」列即可。</p>
          ) : (
            <div className="grid gap-2">
              {indexes.map((ix, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md border p-2">
                  <Input
                    value={ix.name}
                    onChange={(e) => updateIndex(i, { name: e.target.value })}
                    placeholder="索引名（可留空自动生成）"
                    className="h-7 w-48 font-mono"
                  />
                  <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
                    <Checkbox
                      checked={ix.unique}
                      onCheckedChange={(v) => updateIndex(i, { unique: v === true })}
                    />
                    唯一
                  </label>
                  <IndexColumnPicker
                    options={cols.map((c) => c.name.trim()).filter(Boolean)}
                    value={ix.columns}
                    onChange={(columns) => updateIndex(i, { columns })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto size-6 text-muted-foreground hover:text-destructive"
                    title="删除这个索引"
                    onClick={() => setIndexes((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {statements.join(";\n\n")}
        </pre>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void run()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 创建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 索引包含哪些列：点开勾选，收起时显示已选 */
function IndexColumnPicker({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 max-w-64 justify-start font-normal">
          <span className="truncate">{value.length > 0 ? value.join(", ") : "选择列…"}</span>
          <ChevronDown className="ml-1 size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {options.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">先在上面把列名填上</p>
        ) : (
          <div className="max-h-56 space-y-0.5 overflow-auto">
            {options.map((c) => {
              const on = value.includes(c);
              return (
                <label
                  key={c}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/60"
                >
                  <Checkbox
                    checked={on}
                    onCheckedChange={() => onChange(on ? value.filter((v) => v !== c) : [...value, c])}
                  />
                  <span className="font-mono">{c}</span>
                </label>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
