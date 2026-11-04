import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Copy, PanelRight, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { imageDataUrl } from "@/lib/blob";
import { rowToCsv, rowToJson, rowToMarkdown, rowToTsv } from "@/lib/exporters";
import { fieldKind, parseEnumValues, type FieldKind } from "@/lib/field";
import { FieldInput } from "@/components/FieldInput";
import { valueToDisplay, valueToText, type Column, type Value } from "@/lib/types";
import { RowDetailDrawer } from "./RowDetailDrawer";

export interface EditableConfig {
  primaryKeys: string[];
  canEditCell: (rowIndex: number, column: string) => boolean;
  isDirty: (rowIndex: number, column: string) => boolean;
  isRowDeleted: (rowIndex: number) => boolean;
  isRowInserted: (rowIndex: number) => boolean;
  /** 提交失败的这一行 */
  isRowFailed?: (rowIndex: number) => boolean;
  onStartEdit: (rowIndex: number, column: string) => void;
  onDeleteRow: (rowIndex: number) => void;
  onStageEdit: (rowIndex: number, column: string, value: string | null) => void;
  /** 双击已暂存的新增行 → 打开「新增行」弹窗重新编辑 */
  onEditInsertedRow?: (rowIndex: number) => void;
}

export interface ColumnMeta {
  dataType: string;
  rawType: string;
}

/** 虚拟滚动按行高估算；行内容都是单行 `text-xs`，高度基本一致 */
const VIRTUAL_ROW_HEIGHT = 35;

/**
 * 虚拟化要求列宽稳定：表格用 table-fixed，宽度按表头和前若干行估一次。
 * 不这么做的话，列宽会跟着「当前渲染了哪几行」变，滚动时列会跳。
 */
function estimateColumnWidths(columns: Column[], rows: Value[][]): number[] {
  const CHAR_WIDTH = 7.2;
  const MIN_WIDTH = 90;
  const MAX_WIDTH = 320;
  const SAMPLE_ROWS = 50;
  return columns.map((c, i) => {
    let chars = c.name.length + (c.type_name ? c.type_name.length + 1 : 0);
    const limit = Math.min(rows.length, SAMPLE_ROWS);
    for (let r = 0; r < limit; r += 1) {
      const len = valueToText(rows[r]?.[i] ?? { type: "null" }).length;
      if (len > chars) chars = len;
    }
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(chars * CHAR_WIDTH) + 24));
  });
}

interface Props {
  columns: Column[];
  rows: Value[][];
  empty?: string;
  editable?: EditableConfig;
  meta?: Record<string, ColumnMeta>;
  editing?: { rowIndex: number; column: string } | null;
  draft?: string;
  draftNull?: boolean;
  /** 把某一行滚进视口（新增行、提交失败的行）；nonce 变化时触发 */
  scrollTarget?: { row: number; nonce: number } | null;
  /** 外键列 → 引用表/列，用于「跳转」 */
  foreignKeys?: Record<string, { table: string; column: string }>;
  onForeignKeyJump?: (column: string, value: string, target: { table: string; column: string }) => void;
  onDraftChange?: (v: string) => void;
  onDraftNullChange?: (n: boolean) => void;
  onCommitEdit?: () => void;
  onCancelEdit?: () => void;
}

interface CellDialog {
  rowIndex: number;
  column: string;
  text: string;
  /** 原始值，用来做二进制图片预览 */
  value: Value;
  isNull: boolean;
  editable: boolean;
  kind: FieldKind;
  enumValues: string[];
}

export function ResultsGrid({
  columns,
  rows,
  empty = "暂无数据",
  editable,
  meta,
  editing,
  draft = "",
  draftNull = false,
  scrollTarget = null,
  foreignKeys,
  onForeignKeyJump,
  onDraftChange,
  onDraftNullChange,
  onCommitEdit,
  onCancelEdit,
}: Props) {
  const [cell, setCell] = useState<CellDialog | null>(null);
  const [detailRow, setDetailRow] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const clickTimer = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);


  const colWidths = useMemo(() => estimateColumnWidths(columns, rows), [columns, rows]);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => VIRTUAL_ROW_HEIGHT,
    overscan: 8,
  });

  // 虚拟化之后屏幕外的行不在 DOM 里，定位得交给 virtualizer（原本是 scrollIntoView 找节点）
  useEffect(() => {
    if (!scrollTarget) return;
    rowVirtualizer.scrollToIndex(scrollTarget.row, { align: "center" });
  }, [scrollTarget, rowVirtualizer]);



  // 这几个 handler 要把引用稳住，下面行列表的 useMemo 才会真正命中
  const openDialog = useCallback(
    (rowIndex: number, ci: number) => {
      const colName = columns[ci]?.name ?? String(ci);
      const info = meta?.[colName];
      const kind = fieldKind(info?.dataType ?? "", info?.rawType ?? "");
      const v: Value = rows[rowIndex]?.[ci] ?? { type: "null" };
      setCell({
        rowIndex,
        column: colName,
        text: valueToText(v),
        value: v,
        isNull: v.type === "null",
        editable: (editable?.canEditCell(rowIndex, colName) ?? false) && kind !== "binary",
        kind,
        enumValues: kind === "enum" || kind === "set" ? parseEnumValues(info?.rawType ?? "") : [],
      });
      setHint(null);
    },
    [columns, meta, rows, editable],
  );

  // 单击延时打开弹窗；双击会取消它并进入行内编辑
  const scheduleDialog = useCallback(
    (rowIndex: number, ci: number) => {
      if (clickTimer.current !== null) return;
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        openDialog(rowIndex, ci);
      }, 200);
    },
    [openDialog],
  );

  const cancelPendingDialog = useCallback(() => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  }, []);

  // 渲染一行。虚拟化之后只有可视区的几十行进 DOM，这里不再需要 memo
  function renderRow(row: Value[], ri: number) {
        const deleted = editable?.isRowDeleted(ri) ?? false;
        const inserted = editable?.isRowInserted(ri) ?? false;
        const failed = editable?.isRowFailed?.(ri) ?? false;
        return (
          <TableRow
            key={ri}
            data-row={ri}
            className={cn(
              deleted && "bg-red-50 text-muted-foreground line-through dark:bg-red-400/10",
              inserted && "bg-emerald-50 dark:bg-emerald-400/10",
              failed && "bg-red-100 ring-1 ring-red-400 ring-inset dark:bg-red-500/20 dark:ring-red-400/70",
            )}
          >
            {editable && (
              <TableCell className="w-10 p-1 text-center">
                <button
                  type="button"
                  className="rounded px-1 text-xs text-muted-foreground hover:text-destructive"
                  title="删除行"
                  onClick={() => editable.onDeleteRow(ri)}
                >
                  ✕
                </button>
              </TableCell>
            )}
            {row.map((v, ci) => {
              const colName = columns[ci]?.name ?? String(ci);
              const isEditing = editing?.rowIndex === ri && editing?.column === colName;
              const editableCell = editable?.canEditCell(ri, colName) ?? false;
              const dirty = editable?.isDirty(ri, colName) ?? false;
              return (
                <TableCell
                  key={ci}
                  className={cn(
                    "max-w-80 cursor-pointer font-mono text-xs whitespace-nowrap",
                    isEditing ? "relative overflow-visible" : "truncate",
                    dirty && "bg-amber-50 dark:bg-amber-400/15",
                  )}
                  onClick={() => scheduleDialog(ri, ci)}
                  onDoubleClick={() => {
                    cancelPendingDialog();
                    // 新增行整行走弹窗编辑，其余走行内编辑
                    if (inserted && editable?.onEditInsertedRow) editable.onEditInsertedRow(ri);
                    else if (editableCell) editable!.onStartEdit(ri, colName);
                    // 只读结果（例如 SQL 查询结果）双击直接看整行详情
                    else setDetailRow(ri);
                  }}
                >
                  {isEditing ? (
                    <span className="absolute top-0 bottom-0 left-0 z-20 flex items-center gap-1 bg-background pr-0.5 pl-1 shadow-sm ring-1 ring-ring">
                      <input
                        autoFocus
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="h-full w-56 border-0 bg-transparent text-xs outline-none"
                        disabled={draftNull}
                        value={draft}
                        onChange={(e) => onDraftChange?.(e.target.value)}
                        onBlur={() => onCommitEdit?.()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onCommitEdit?.();
                          if (e.key === "Escape") onCancelEdit?.();
                        }}
                      />
                      <button
                        type="button"
                        className={cn("shrink-0 rounded border px-1 text-[10px]", draftNull ? "bg-foreground text-background" : "text-muted-foreground")}
                        title="设为 NULL"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onDraftNullChange?.(!draftNull)}
                      >
                        NULL
                      </button>
                    </span>
                  ) : (
                    valueToDisplay(v)
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        );
  }

  function setText(text: string) {
    setCell((c) => (c ? { ...c, text } : c));
  }

  function formatJson() {
    if (!cell || cell.isNull) return;
    try {
      setCell({ ...cell, text: JSON.stringify(JSON.parse(cell.text), null, 2) });
      setHint(null);
    } catch {
      setHint("不是合法的 JSON，无法格式化");
    }
  }

  async function copyRow(kind: "tsv" | "csv" | "json" | "markdown") {
    if (!cell) return;
    const row = rows[cell.rowIndex] ?? [];
    const text =
      kind === "csv"
        ? rowToCsv(columns, row)
        : kind === "json"
          ? rowToJson(columns, row)
          : kind === "markdown"
            ? rowToMarkdown(columns, row)
            : rowToTsv(row);
    const ok = await copyText(text);
    if (ok) toast.success(`已复制整行（${kind.toUpperCase()}）`);
    else setHint("复制失败");
  }

  // 二进制 → 图片 data URL（注意：这里在 early return 之后，不能放 hook）
  const cellImage = cell ? imageDataUrl(cell.value) : null;

  function stage() {
    if (!cell || !editable) return;
    editable.onStageEdit(cell.rowIndex, cell.column, cell.isNull ? null : cell.text);
    setCell(null);
  }

  function renderControl(c: CellDialog) {
    return (
      <FieldInput
        kind={c.kind}
        text={c.text}
        enumValues={c.enumValues}
        isNull={c.isNull}
        disabled={!c.editable}
        onChange={setText}
      />
    );
  }

  // 这个 early return 必须排在所有 hook 之后
  if (rows.length === 0) {
    return <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{empty}</div>;
  }

  const virtualItems = rowVirtualizer.getVirtualItems();
  const firstItem = virtualItems[0];
  const lastItem = virtualItems[virtualItems.length - 1];

  return (
    <>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <Table className="table-fixed">
          <colgroup>
            {editable && <col style={{ width: 40 }} />}
            {colWidths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow>
              {editable && <TableHead className="sticky top-0 z-10 w-10 bg-muted" />}
              {columns.map((c, i) => (
                <TableHead key={i} className="sticky top-0 z-10 bg-muted text-xs whitespace-nowrap">
                  {c.name}
                  {c.type_name && (
                    <span className="ml-1.5 font-normal text-muted-foreground">{c.type_name}</span>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* 上下各一条占位行撑出滚动高度，真正的行只渲染可视区那几十条 */}
            {firstItem && firstItem.start > 0 && (
              <TableRow aria-hidden className="border-0" style={{ height: firstItem.start }} />
            )}
            {virtualItems.map((vi) => renderRow(rows[vi.index], vi.index))}
            {lastItem && (
              <TableRow
                aria-hidden
                className="border-0"
                style={{
                  height: Math.max(0, rowVirtualizer.getTotalSize() - (lastItem.start + lastItem.size)),
                }}
              />
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!cell} onOpenChange={(o) => !o && setCell(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono">{cell?.column}</DialogTitle>
            <DialogDescription>
              第 {(cell?.rowIndex ?? 0) + 1} 行的单元格内容{cell?.editable ? "（可编辑）" : ""}
            </DialogDescription>
          </DialogHeader>
          {cellImage && (
            <div className="flex flex-col gap-1">
              <img
                src={cellImage}
                alt={cell?.column}
                className="max-h-64 w-fit max-w-full rounded-md border object-contain"
              />
              <span className="text-[11px] text-muted-foreground">
                图片预览 · {cell?.value.type === "bytes" ? `${cell.value.value.length} 字节` : ""}
              </span>
            </div>
          )}
          {cell && renderControl(cell)}
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
          <div className="flex justify-end gap-2">
            {cell?.editable && cell.kind !== "boolean" && cell.kind !== "binary" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCell((c) => (c ? { ...c, isNull: !c.isNull } : c))}
              >
                {cell.isNull ? "取消 NULL" : "NULL"}
              </Button>
            )}
            {(cell?.kind === "json" || cell?.kind === "text") && (
              <Button variant="outline" size="sm" onClick={formatJson}>
                <WandSparkles className="size-3.5" /> 格式化
              </Button>
            )}
            {cell && !cell.isNull && foreignKeys?.[cell.column] && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const target = foreignKeys[cell.column];
                  setCell(null);
                  onForeignKeyJump?.(cell.column, cell.text, target);
                }}
              >
                跳转到 {foreignKeys[cell.column].table}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Copy className="size-3.5" /> 复制整行
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void copyRow("csv")}>复制为 CSV</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copyRow("json")}>复制为 JSON</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copyRow("markdown")}>
                  复制为 Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copyRow("tsv")}>复制为 TSV</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const ri = cell?.rowIndex ?? 0;
                setCell(null);
                setDetailRow(ri);
              }}
            >
              <PanelRight className="size-3.5" /> 整行详情
            </Button>
            {cell?.editable && <Button size="sm" onClick={stage}>暂存</Button>}
          </div>
        </DialogContent>
      </Dialog>

      <RowDetailDrawer
        open={detailRow !== null}
        columns={columns}
        row={detailRow !== null ? (rows[detailRow] ?? null) : null}
        rowIndex={detailRow ?? 0}
        total={rows.length}
        meta={meta}
        onPrev={() => setDetailRow((r) => (r === null ? r : Math.max(0, r - 1)))}
        onNext={() => setDetailRow((r) => (r === null ? r : Math.min(rows.length - 1, r + 1)))}
        onClose={() => setDetailRow(null)}
      />
    </>
  );
}
