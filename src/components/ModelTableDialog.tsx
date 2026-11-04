import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TypeCombobox, COLUMN_TYPES } from "@/components/TypeCombobox";
import type { GraphColumn, GraphEdge, GraphIndex, GraphTable } from "@/lib/types";

/**
 * 模型里编辑一张表（**只改模型，不碰数据库**）。
 * 字段 / 索引 / 外键都在这里编，保存后回到画布，导出 DDL / PDM 或与库对比都用改后的模型。
 */

interface Props {
  open: boolean;
  /** null = 新建表 */
  table: GraphTable | null;
  /** 模型里现有的其它表（外键下拉用） */
  otherTables: GraphTable[];
  /** 这张表现有的外键（出边） */
  edges: GraphEdge[];
  onClose: () => void;
  onSave: (table: GraphTable, edges: GraphEdge[]) => void;
  onDelete?: () => void;
}

interface ColDraft {
  name: string;
  rawType: string;
  logicalName: string;
  comment: string;
  nullable: boolean;
  primaryKey: boolean;
}

interface IndexDraft {
  name: string;
  columns: string; // 逗号分隔
  unique: boolean;
}

interface FkDraft {
  column: string;
  toTable: string;
  toColumn: string;
}

const emptyColumn = (first = false): ColDraft => ({
  name: "",
  rawType: "bigint(20)",
  logicalName: "",
  comment: "",
  nullable: !first,
  primaryKey: first,
});

export function ModelTableDialog({ open, table, otherTables, edges, onClose, onSave, onDelete }: Props) {
  const isNew = !table;
  const [name, setName] = useState("");
  const [logicalName, setLogicalName] = useState("");
  const [comment, setComment] = useState("");
  const [columns, setColumns] = useState<ColDraft[]>([emptyColumn(true)]);
  const [indexes, setIndexes] = useState<IndexDraft[]>([]);
  const [fks, setFks] = useState<FkDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(table?.name ?? "");
    setLogicalName(table?.logical_name ?? "");
    setComment(table?.comment ?? "");
    setColumns(
      table
        ? table.columns.map((c) => ({
            name: c.name,
            rawType: c.raw_type,
            logicalName: c.logical_name ?? "",
            comment: c.comment ?? "",
            nullable: c.nullable,
            primaryKey: c.primary_key,
          }))
        : [emptyColumn(true)],
    );
    setIndexes(
      (table?.indexes ?? [])
        .filter((i) => !i.primary)
        .map((i) => ({ name: i.name, columns: i.columns.join(", "), unique: i.unique })),
    );
    setFks(
      edges.map((e) => ({ column: e.from_column, toTable: e.to_table, toColumn: e.to_column })),
    );
  }, [open, table, edges]);

  const columnNames = useMemo(() => columns.map((c) => c.name.trim()).filter(Boolean), [columns]);

  function update(i: number, patch: Partial<ColDraft>) {
    setColumns((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  function save() {
    const tableName = name.trim();
    if (!tableName) {
      setError("表名不能为空");
      return;
    }
    const filled = columns.filter((c) => c.name.trim());
    if (filled.length === 0) {
      setError("至少要有一个字段");
      return;
    }
    const seen = new Set<string>();
    for (const c of filled) {
      const key = c.name.trim().toLowerCase();
      if (seen.has(key)) {
        setError(`字段名重复：${c.name.trim()}`);
        return;
      }
      seen.add(key);
    }
    const fkColumns = new Set(fks.map((f) => f.column));
    const graphColumns: GraphColumn[] = filled.map((c) => ({
      name: c.name.trim(),
      raw_type: c.rawType.trim() || "varchar(64)",
      nullable: c.nullable,
      primary_key: c.primaryKey,
      foreign_key: fkColumns.has(c.name),
      comment: c.comment.trim(),
      logical_name: c.logicalName.trim(),
    }));
    const graphIndexes: GraphIndex[] = indexes
      .filter((ix) => ix.columns.trim())
      .map((ix, i) => ({
        name: ix.name.trim() || `IDX_${tableName}_${i + 1}`,
        columns: ix.columns
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        unique: ix.unique,
        primary: false,
      }));
    const graphEdges: GraphEdge[] = fks
      .filter((f) => f.column && f.toTable && f.toColumn)
      .map((f) => ({
        from_table: tableName,
        from_column: f.column,
        to_table: f.toTable,
        to_column: f.toColumn,
        name: `FK_${tableName}_${f.toTable}`,
      }));
    onSave(
      {
        name: tableName,
        columns: graphColumns,
        comment: comment.trim(),
        logical_name: logicalName.trim(),
        indexes: graphIndexes,
      },
      graphEdges,
    );
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-3 sm:max-w-4xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{isNew ? "新建表（模型）" : `编辑表 ${table?.name}`}</DialogTitle>
          <DialogDescription>
            只改模型，不会执行到数据库；保存后可以导出 DDL / PDM，或用「对比数据库」生成 ALTER。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-1.5">
            <Label>表名（Code）</Label>
            <Input className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="t_order" />
          </div>
          <div className="grid gap-1.5">
            <Label>逻辑名（Name）</Label>
            <Input value={logicalName} onChange={(e) => setLogicalName(e.target.value)} placeholder="订单表" />
          </div>
          <div className="grid gap-1.5">
            <Label>注释（Comment）</Label>
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="可选" />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {/* 字段 */}
          <div className="mb-1 flex items-center gap-2">
            <span className="text-sm font-medium">字段</span>
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              onClick={() => setColumns((prev) => [...prev, emptyColumn()])}
            >
              <Plus className="size-3" /> 加字段
            </Button>
          </div>
          <div className="rounded-md border">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="w-[18%] px-2 py-1 text-left">列名</th>
                  <th className="w-[18%] px-2 py-1 text-left">类型</th>
                  <th className="w-[16%] px-2 py-1 text-left">逻辑名</th>
                  <th className="w-[20%] px-2 py-1 text-left">注释</th>
                  <th className="w-[9%] px-2 py-1">可空</th>
                  <th className="w-[9%] px-2 py-1">主键</th>
                  <th className="w-[6%] px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {columns.map((c, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-1">
                      <Input className="h-7 font-mono" value={c.name} onChange={(e) => update(i, { name: e.target.value })} />
                    </td>
                    <td className="p-1">
                      <TypeCombobox
                        value={c.rawType}
                        onChange={(v) => update(i, { rawType: v })}
                        options={COLUMN_TYPES}
                        className="[&_input]:h-7"
                      />
                    </td>
                    <td className="p-1">
                      <Input className="h-7" value={c.logicalName} onChange={(e) => update(i, { logicalName: e.target.value })} />
                    </td>
                    <td className="p-1">
                      <Input className="h-7" value={c.comment} onChange={(e) => update(i, { comment: e.target.value })} />
                    </td>
                    <td className="p-1 text-center">
                      <Checkbox checked={c.nullable} onCheckedChange={(v) => update(i, { nullable: v === true })} />
                    </td>
                    <td className="p-1 text-center">
                      <Checkbox checked={c.primaryKey} onCheckedChange={(v) => update(i, { primaryKey: v === true })} />
                    </td>
                    <td className="p-1 text-center">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={columns.length <= 1}
                        onClick={() => setColumns((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 索引 */}
          <div className="mt-4 mb-1 flex items-center gap-2">
            <span className="text-sm font-medium">索引</span>
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              onClick={() => setIndexes((prev) => [...prev, { name: "", columns: "", unique: false }])}
            >
              <Plus className="size-3" /> 加索引
            </Button>
          </div>
          {indexes.length === 0 ? (
            <p className="text-xs text-muted-foreground">（没有索引）</p>
          ) : (
            <div className="grid gap-2">
              {indexes.map((ix, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="h-7 w-1/3 font-mono"
                    placeholder="索引名，如 IDX_ORDER_USER"
                    value={ix.name}
                    onChange={(e) =>
                      setIndexes((prev) => prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))
                    }
                  />
                  <Input
                    className="h-7 flex-1 font-mono"
                    placeholder={`列名，逗号分隔（可填：${columnNames.join(", ") || "先填字段"}）`}
                    value={ix.columns}
                    onChange={(e) =>
                      setIndexes((prev) => prev.map((x, idx) => (idx === i ? { ...x, columns: e.target.value } : x)))
                    }
                  />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={ix.unique}
                      onCheckedChange={(v) =>
                        setIndexes((prev) => prev.map((x, idx) => (idx === i ? { ...x, unique: v === true } : x)))
                      }
                    />
                    唯一
                  </label>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => setIndexes((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* 外键 */}
          <div className="mt-4 mb-1 flex items-center gap-2">
            <span className="text-sm font-medium">外键（本表 → 其它表）</span>
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              disabled={otherTables.length === 0}
              onClick={() =>
                setFks((prev) => [...prev, { column: "", toTable: otherTables[0]?.name ?? "", toColumn: "" }])
              }
            >
              <Plus className="size-3" /> 加外键
            </Button>
          </div>
          {fks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {otherTables.length === 0 ? "（模型里还没有其它表，先新建一张）" : "（没有外键）"}
            </p>
          ) : (
            <div className="grid gap-2">
              {fks.map((fk, i) => {
                const target = otherTables.find((t) => t.name === fk.toTable);
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                      value={fk.column || undefined}
                      onValueChange={(v) => setFks((prev) => prev.map((x, idx) => (idx === i ? { ...x, column: v } : x)))}
                    >
                      <SelectTrigger className="h-7 w-1/3 font-mono">
                        <SelectValue placeholder="本表列" />
                      </SelectTrigger>
                      <SelectContent>
                        {columnNames.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="shrink-0 text-xs text-muted-foreground">→</span>
                    <Select
                      value={fk.toTable}
                      onValueChange={(v) =>
                        setFks((prev) => prev.map((x, idx) => (idx === i ? { ...x, toTable: v, toColumn: "" } : x)))
                      }
                    >
                      <SelectTrigger className="h-7 w-1/3 font-mono">
                        <SelectValue placeholder="目标表" />
                      </SelectTrigger>
                      <SelectContent>
                        {otherTables.map((t) => (
                          <SelectItem key={t.name} value={t.name}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={fk.toColumn || undefined}
                      onValueChange={(v) => setFks((prev) => prev.map((x, idx) => (idx === i ? { ...x, toColumn: v } : x)))}
                    >
                      <SelectTrigger className="h-7 flex-1 font-mono">
                        <SelectValue placeholder="目标列" />
                      </SelectTrigger>
                      <SelectContent>
                        {(target?.columns ?? []).map((c) => (
                          <SelectItem key={c.name} value={c.name}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => setFks((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

        <div className="flex shrink-0 items-center justify-end gap-2">
          {!isNew && onDelete && (
            <Button variant="destructive" size="sm" className="mr-auto" onClick={onDelete}>
              <Trash2 className="size-4" /> 从模型里删除这张表
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={save}>
            保存到模型
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
