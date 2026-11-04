import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { pickCsvFile } from "@/lib/exporters";
import type { ColumnInfo, ImportPreview, ImportReport } from "@/lib/types";

interface Props {
  open: boolean;
  connectionId: string | null;
  database: string;
  table: string;
  columns: ColumnInfo[];
  onClose: () => void;
  onImported: (report: ImportReport) => void;
}

const DELIMITERS = [",", ";", "\t"];

export function ImportCsvDialog({ open, connectionId, database, table, columns, onClose, onImported }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [skipErrors, setSkipErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPath(null);
    setPreview(null);
    setReport(null);
    setError(null);
    (async () => {
      const p = await pickCsvFile();
      if (!p) {
        onClose();
        return;
      }
      try {
        const pv = await api.importCsvPreview(p);
        setPath(p);
        setPreview(pv);
        setDelimiter(pv.delimiter);
        setHasHeader(pv.has_header);
        const map: Record<string, string> = {};
        for (const fc of pv.columns) {
          const match = columns.find((c) => c.name.toLowerCase() === fc.toLowerCase());
          map[fc] = match?.name ?? "";
        }
        setMapping(map);
      } catch (e) {
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tableColumns = useMemo(() => columns.map((c) => c.name), [columns]);
  const mappedCount = Object.values(mapping).filter(Boolean).length;

  async function run() {
    if (!connectionId || !path) return;
    setBusy(true);
    setError(null);
    try {
      const entries = Object.entries(mapping)
        .filter(([, tc]) => tc)
        .map(([file_column, table_column]) => ({ file_column, table_column }));
      const r = await api.importCsv(connectionId, database, table, path, delimiter, hasHeader, entries, skipErrors);
      setReport(r);
      onImported(r);
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
          <DialogTitle>导入 CSV</DialogTitle>
          <DialogDescription>
            导入到 {database}.{table}；空单元格会写入 NULL。
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {error ?? "请选择 CSV 文件…"}
          </div>
        ) : report ? (
          <div className="space-y-2 text-sm">
            <div className="text-green-700">成功导入 {report.imported} 行，失败 {report.failed} 行。</div>
            {report.errors.length > 0 && (
              <pre className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                {report.errors.join("\n")}
              </pre>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 text-sm">
              <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
              <label className="flex items-center gap-1.5">
                <Checkbox checked={hasHeader} onCheckedChange={(v) => setHasHeader(v === true)} />
                首行是表头
              </label>
              <label className="flex items-center gap-1.5">
                分隔符
                <Select value={delimiter} onValueChange={setDelimiter}>
                  <SelectTrigger className="h-7 w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DELIMITERS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d === "\t" ? "制表符" : d === "," ? "逗号" : "分号"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="ml-auto flex items-center gap-1.5 text-xs">
                <Checkbox checked={skipErrors} onCheckedChange={(v) => setSkipErrors(v === true)} />
                跳过错误行
              </label>
            </div>

            <div className="max-h-64 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-left">CSV 列</th>
                    <th className="px-2 py-1 text-left">对应表列</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.columns.map((fc) => (
                    <tr key={fc} className="border-t">
                      <td className="px-2 py-1 font-mono">{fc}</td>
                      <td className="px-2 py-1">
                        <Select value={mapping[fc] ?? ""} onValueChange={(v) => setMapping((m) => ({ ...m, [fc]: v }))}>
                          <SelectTrigger className="h-7 w-full">
                            <SelectValue placeholder="不导入" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">不导入</SelectItem>
                            {tableColumns.map((tc) => (
                              <SelectItem key={tc} value={tc}>
                                {tc}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="text-[11px] text-muted-foreground">
              已映射 {mappedCount} 列。前 5 行预览：
            </div>
            <div className="max-h-28 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] [overflow-wrap:anywhere]">
              {preview.sample.map((row, i) => (
                <div key={i}>{row.join(" | ")}</div>
              ))}
            </div>
          </>
        )}

        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {report ? "关闭" : "取消"}
          </Button>
          {preview && !report && (
            <Button size="sm" disabled={busy || mappedCount === 0} onClick={() => void run()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 开始导入
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
