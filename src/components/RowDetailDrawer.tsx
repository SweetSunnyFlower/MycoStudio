import { Dialog as DialogPrimitive } from "radix-ui";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyText } from "@/lib/clipboard";
import { imageDataUrl } from "@/lib/blob";
import { rowToCsv, rowToJson, rowToMarkdown, rowToTsv } from "@/lib/exporters";
import { fieldKind } from "@/lib/field";
import { valueToDisplay, type Column, type Value } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface RowDetailMeta {
  dataType: string;
  rawType: string;
}

interface Props {
  open: boolean;
  columns: Column[];
  row: Value[] | null;
  rowIndex: number;
  total: number;
  meta?: Record<string, RowDetailMeta>;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

function ValueView({ column, value, meta }: { column: Column; value: Value; meta?: RowDetailMeta }) {
  const img = imageDataUrl(value);
  if (img) {
    return (
      <div className="flex flex-col gap-1">
        <img
          src={img}
          alt={column.name}
          className="max-h-64 w-fit max-w-full rounded-md border object-contain"
        />
        <span className="text-[11px] text-muted-foreground">
          {value.type === "bytes" ? `图片预览 · ${value.value.length} 字节` : ""}
        </span>
      </div>
    );
  }
  if (value.type === "null") {
    return <span className="font-mono text-xs text-muted-foreground">NULL</span>;
  }
  if (value.type === "default") {
    return <span className="font-mono text-xs text-muted-foreground">(默认)</span>;
  }
  const text = valueToDisplay(value);
  if (fieldKind(meta?.dataType ?? "", meta?.rawType ?? "") === "json") {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // 不是合法 JSON 就原样显示
    }
    return (
      <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
        {pretty}
      </pre>
    );
  }
  return <div className="font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{text}</div>;
}

export function RowDetailDrawer({
  open,
  columns,
  row,
  rowIndex,
  total,
  meta,
  onPrev,
  onNext,
  onClose,
}: Props) {
  async function copy(kind: "tsv" | "csv" | "json" | "markdown") {
    if (!row) return;
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
    else toast.error("复制失败");
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-0 right-0 z-50 flex h-full w-[460px] max-w-[92vw] flex-col gap-3 border-l bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none",
            "duration-150 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          )}
        >
          <DialogPrimitive.Title className="pr-8 font-heading text-base font-medium">
            第 {rowIndex + 1} 行详情
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-xs text-muted-foreground">
            共 {total} 行 · {columns.length} 个字段
          </DialogPrimitive.Description>

          <div className="flex shrink-0 items-center gap-1">
            <Button size="xs" variant="outline" disabled={rowIndex <= 0} onClick={onPrev}>
              <ChevronLeft className="size-3.5" /> 上一行
            </Button>
            <Button size="xs" variant="outline" disabled={rowIndex >= total - 1} onClick={onNext}>
              下一行 <ChevronRight className="size-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="outline" className="ml-auto">
                  <Copy className="size-3.5" /> 复制整行
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void copy("csv")}>复制为 CSV</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copy("json")}>复制为 JSON</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copy("markdown")}>
                  复制为 Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copy("tsv")}>复制为 TSV</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {columns.map((c, i) => {
              const v: Value = row?.[i] ?? { type: "null" };
              const m = meta?.[c.name];
              return (
                <div key={`${c.name}-${i}`} className="grid gap-1 rounded-md border p-2">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-mono text-xs font-medium">{c.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {m?.rawType || c.type_name}
                    </span>
                  </div>
                  <ValueView column={c} value={v} meta={m} />
                </div>
              );
            })}
          </div>

          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2"
              aria-label="关闭"
            >
              <X className="size-4" />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
