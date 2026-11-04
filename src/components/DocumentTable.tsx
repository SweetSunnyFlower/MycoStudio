import { useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** 行高估算；行内容是单行 `text-xs`，高度基本一致 */
const ROW_HEIGHT = 30;

/**
 * 文档表格（MongoDB 文档 / Elasticsearch 命中）：只渲染可视区的行。
 *
 * 虚拟化要求列宽稳定，否则列宽会跟着「当前渲染了哪几行」变、滚动时列会跳，
 * 所以这里用 table-fixed + colgroup，宽度按列名和前若干行估一次。
 */
export function DocumentTable<T>({
  columns,
  documents,
  renderCell,
  onRowClick,
  empty,
}: {
  columns: string[];
  documents: T[];
  renderCell: (doc: T, column: string) => ReactNode;
  onRowClick?: (doc: T) => void;
  empty?: string;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);

  const colWidths = useMemo(() => {
    const CHAR_WIDTH = 7.2;
    const SAMPLE_ROWS = 50;
    return columns.map((c) => {
      let chars = c.length;
      const limit = Math.min(documents.length, SAMPLE_ROWS);
      for (let r = 0; r < limit; r += 1) {
        const len = String(renderCell(documents[r], c) ?? "").length;
        if (len > chars) chars = len;
      }
      return Math.min(320, Math.max(90, Math.round(chars * CHAR_WIDTH) + 24));
    });
    // 只用来估宽度，renderCell 换新引用没必要重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, documents]);

  const virtualizer = useVirtualizer({
    count: documents.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  if (documents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {empty ?? "没有数据"}
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];

  return (
    <div ref={scroller} className="h-full overflow-auto">
      <Table className="table-fixed">
        <colgroup>
          {colWidths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <TableHeader className="sticky top-0 bg-muted">
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c} className="max-w-64 truncate font-mono text-xs">{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* 上下占位行撑出滚动高度，真正的行只渲染可视区那几十条 */}
          {first && first.start > 0 && (
            <TableRow aria-hidden className="border-0" style={{ height: first.start }} />
          )}
          {items.map((vi) => {
            const doc = documents[vi.index];
            return (
              <TableRow key={vi.index} className="cursor-pointer" onClick={() => onRowClick?.(doc)}>
                {columns.map((c) => (
                  <TableCell key={c} className="max-w-64 truncate font-mono text-xs">
                    {renderCell(doc, c)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
          {last && (
            <TableRow
              aria-hidden
              className="border-0"
              style={{ height: Math.max(0, virtualizer.getTotalSize() - (last.start + last.size)) }}
            />
          )}
        </TableBody>
      </Table>
    </div>
  );
}
