import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { ColumnInfo, DbFlavor, IndexInfo } from "@/lib/types";
import { defaultOptions, formatDefault } from "@/lib/sqlDefault";
import { COLUMN_TYPES, ORACLE_TYPES, TypeCombobox } from "./TypeCombobox";

export type DdlMode =
  | "add_column"
  | "alter_column"
  | "drop_column"
  | "add_index"
  | "drop_index"
  | "drop_table"
  | "truncate"
  | "table_comment";

interface Props {
  open: boolean;
  database: string;
  table: string;
  columns: ColumnInfo[];
  /** 表的索引列表，用于「删索引」下拉（不传则退回手输） */
  indexes?: IndexInfo[];
  mode: DdlMode;
  target?: string;
  /** mode = table_comment 时的初始值 */
  initialComment?: string;
  onClose: () => void;
  onExecuted: () => void;
}

const DANGEROUS: DdlMode[] = ["drop_column", "drop_index", "drop_table", "truncate"];

function quote(name: string, flavor?: DbFlavor) {
  const q = flavor === "sqlite" || flavor === "postgres" || flavor === "oracle" ? '"' : "`";
  return q + name.replace(new RegExp(q, "g"), q + q) + q;
}

/** SQL 字符串字面量 */
function quoteStr(s: string) {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

export function DdlDialog({
  open,
  database,
  table,
  columns,
  indexes,
  mode,
  target,
  initialComment,
  onClose,
  onExecuted,
}: Props) {
  const activeId = useAppStore((s) => s.activeId);
  const flavor = useAppStore((s) => s.connections.find((c) => c.id === s.activeId)?.flavor);
  const columnTypes = flavor === "oracle" ? ORACLE_TYPES : COLUMN_TYPES;

  const [name, setName] = useState(target ?? "");
  const [type, setType] = useState("VARCHAR(255)");
  const [nullable, setNullable] = useState(true);
  const [defaultValue, setDefaultValue] = useState("");
  const [comment, setComment] = useState("");
  const [indexName, setIndexName] = useState("");
  const [indexColumns, setIndexColumns] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 「删索引」下拉里可选项：主键索引不能这么删，排除掉
  const droppable = (indexes ?? []).filter((ix) => !ix.primary);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirmText("");
    setName(
      target ??
        (mode === "drop_index"
          ? ((indexes ?? []).find((ix) => !ix.primary)?.name ?? "")
          : ""),
    );
    setIndexName("");
    setIndexColumns([]);
    setUnique(false);
    const col = columns.find((c) => c.name === target);
    if (mode === "table_comment") {
      setComment(initialComment ?? "");
    } else if (col) {
      setType(col.raw_type || col.data_type);
      setNullable(col.nullable);
      setDefaultValue(col.default_value ?? "");
      setComment(col.comment ?? "");
    } else {
      setType("VARCHAR(255)");
      setNullable(true);
      setDefaultValue("");
      setComment("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, target]);

  const statements = useMemo(() => {
    const t = `${quote(database, flavor)}.${quote(table, flavor)}`;
    const fmtDefault = formatDefault(type, defaultValue);
    const col = quote(name, flavor);
    const isPg = flavor === "postgres";
    const isOracle = flavor === "oracle";
    const isMysql = flavor === "mysql" || flavor === "mariadb" || flavor === "tidb";
    const out: string[] = [];
    switch (mode) {
      case "add_column":
        if (isPg || isOracle) {
          // Oracle：没有 COLUMN 关键字和行内注释，注释要单独一句
          if (isOracle) {
            out.push(`ALTER TABLE ${t} ADD (${col} ${type}${nullable ? "" : " NOT NULL"}${fmtDefault ? ` DEFAULT ${fmtDefault}` : ""})`);
          } else {
            out.push(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}${nullable ? "" : " NOT NULL"}${fmtDefault ? ` DEFAULT ${fmtDefault}` : ""}`);
          }
          if (comment) out.push(`COMMENT ON COLUMN ${t}.${col} IS ${quoteStr(comment)}`);
        } else {
          out.push(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}${nullable ? "" : " NOT NULL"}${fmtDefault ? ` DEFAULT ${fmtDefault}` : ""}${comment ? ` COMMENT ${quoteStr(comment)}` : ""}`);
        }
        break;
      case "alter_column":
        if (isPg) {
          if (type.trim()) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${type}`);
          out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${nullable ? "DROP NOT NULL" : "SET NOT NULL"}`);
          if (defaultValue.trim()) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${fmtDefault}`);
          else out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`);
          out.push(`COMMENT ON COLUMN ${t}.${col} IS ${comment ? quoteStr(comment) : "NULL"}`);
        } else if (isOracle) {
          // Oracle 的 MODIFY 一句话搞定类型 / 可空 / 默认值；注释单独一句
          out.push(`ALTER TABLE ${t} MODIFY (${col}${type.trim() ? ` ${type}` : ""}${nullable ? " NULL" : " NOT NULL"}${fmtDefault ? ` DEFAULT ${fmtDefault}` : ""})`);
          if (comment) out.push(`COMMENT ON COLUMN ${t}.${col} IS ${quoteStr(comment)}`);
        } else {
          out.push(`ALTER TABLE ${t} MODIFY COLUMN ${col} ${type}${nullable ? "" : " NOT NULL"}${fmtDefault ? ` DEFAULT ${fmtDefault}` : ""}${comment ? ` COMMENT ${quoteStr(comment)}` : ""}`);
        }
        break;
      case "drop_column":
        out.push(`ALTER TABLE ${t} DROP COLUMN ${col}`);
        break;
      case "add_index":
        out.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(indexName || `idx_${table}_${indexColumns.join("_")}`, flavor)} ON ${t} (${indexColumns.map((c) => quote(c, flavor)).join(", ")})`);
        break;
      case "drop_index":
        out.push(isMysql ? `DROP INDEX ${quote(name, flavor)} ON ${t}` : `DROP INDEX ${quote(name, flavor)}`);
        break;
      case "drop_table":
        out.push(`DROP TABLE ${t}`);
        break;
      case "truncate":
        out.push(flavor === "sqlite" ? `DELETE FROM ${t}` : `TRUNCATE TABLE ${t}`);
        break;
      case "table_comment":
        out.push(
          isPg || isOracle
            ? `COMMENT ON TABLE ${t} IS ${quoteStr(comment)}`
            : `ALTER TABLE ${t} COMMENT = ${quoteStr(comment)}`,
        );
        break;
    }
    return out;
  }, [mode, database, table, flavor, name, type, nullable, defaultValue, comment, indexName, indexColumns, unique]);

  const needsConfirm = DANGEROUS.includes(mode);
  const confirmValue = mode === "drop_table" || mode === "truncate" ? table : name || indexName;
  const needsName = ["add_column", "alter_column", "drop_column", "drop_index"].includes(mode);
  const nameOk = !needsName || name.trim().length > 0;
  const indexOk = mode !== "add_index" || indexColumns.length > 0;
  const confirmOk = !needsConfirm || (confirmText.trim().length > 0 && confirmText.trim() === confirmValue);
  const ready = nameOk && indexOk && confirmOk;

  async function run() {
    if (!activeId || !ready) return;
    setBusy(true);
    setError(null);
    try {
      for (const statement of statements) {
        await api.runSql(activeId, database, statement);
      }
      onExecuted();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "add_column" && "加列"}
            {mode === "alter_column" && "改列"}
            {mode === "drop_column" && "删列"}
            {mode === "add_index" && "加索引"}
            {mode === "drop_index" && "删索引"}
            {mode === "drop_table" && "删除表"}
            {mode === "truncate" && "清空表"}
            {mode === "table_comment" && "表注释"}
          </DialogTitle>
          <DialogDescription>
            {database}.{table}
          </DialogDescription>
        </DialogHeader>

        {(mode === "add_column" || mode === "alter_column") && (
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>列名</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" disabled={mode === "alter_column"} />
            </div>
            <div className="grid gap-1.5">
              <Label>类型</Label>
              <TypeCombobox value={type} onChange={setType} options={columnTypes} />
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={nullable} onCheckedChange={(v) => setNullable(v === true)} />
              可空
            </label>
            <div className="grid gap-1.5">
              <Label>默认值（可选）</Label>
              <TypeCombobox
                value={defaultValue}
                onChange={setDefaultValue}
                options={defaultOptions(type, flavor)}
                placeholder="选择或输入，如 CURRENT_TIMESTAMP"
              />
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label>注释（可选）</Label>
              <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="这个字段是干什么的" />
            </div>
          </div>
        )}

        {mode === "table_comment" && (
          <div className="grid gap-1.5">
            <Label>表注释</Label>
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="留空则清除注释"
            />
          </div>
        )}

        {mode === "drop_column" && (
          <div className="grid gap-1.5">
            <Label>列名</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
          </div>
        )}

        {mode === "add_index" && (
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>索引名（可留空自动生成）</Label>
                <Input value={indexName} onChange={(e) => setIndexName(e.target.value)} className="font-mono" />
              </div>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={unique} onCheckedChange={(v) => setUnique(v === true)} />
                唯一索引
              </label>
            </div>
            <div className="grid gap-1.5">
              <Label>包含列（可多选）</Label>
              <div className="flex flex-wrap gap-2 rounded-md border p-2">
                {columns.map((c) => {
                  const on = indexColumns.includes(c.name);
                  return (
                    <label key={c.name} className="flex items-center gap-1 text-xs">
                      <Checkbox
                        checked={on}
                        className="size-3.5"
                        onCheckedChange={() =>
                          setIndexColumns((prev) => (on ? prev.filter((n) => n !== c.name) : [...prev, c.name]))
                        }
                      />
                      {c.name}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {mode === "drop_index" && (
          <div className="grid gap-1.5">
            <Label>索引名</Label>
            {droppable.length > 0 ? (
              <>
                <Select value={name} onValueChange={setName}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择要删除的索引" />
                  </SelectTrigger>
                  <SelectContent>
                    {droppable.map((ix) => (
                      <SelectItem key={ix.name} value={ix.name}>
                        {ix.name}
                        {ix.unique ? "（唯一）" : ""} · {ix.columns.join(", ") || "—"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(indexes ?? []).some((ix) => ix.primary) && (
                  <p className="text-xs text-muted-foreground">
                    主键索引不在列表里；要拆主键请直接执行 ALTER TABLE 语句。
                  </p>
                )}
              </>
            ) : (
              <>
                <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
                <p className="text-xs text-muted-foreground">
                  没读到可删除的索引，可直接填索引名。
                </p>
              </>
            )}
          </div>
        )}

        <div className="grid gap-1.5">
          <Label>将执行</Label>
          <pre className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {statements.join("\n")}
          </pre>
        </div>

        {needsConfirm && (
          <div className="grid gap-1.5">
            <Label className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="size-3.5" />
              该操作不可撤销，请输入「{confirmValue}」确认
            </Label>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="font-mono" />
          </div>
        )}

        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" variant={needsConfirm ? "destructive" : "default"} disabled={!ready || busy} onClick={() => void run()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 执行
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
