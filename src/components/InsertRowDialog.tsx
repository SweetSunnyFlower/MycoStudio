import { useEffect, useMemo, useState } from "react";
import { Plus, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldInput } from "@/components/FieldInput";
import { cn } from "@/lib/utils";
import { fieldKind, parseEnumValues } from "@/lib/field";
import type { ColumnInfo } from "@/lib/types";

/** 每个字段三种状态：不指定（用数据库默认值）/ NULL / 具体值 */
type FieldMode = "default" | "null" | "value";

interface Props {
  open: boolean;
  columns: ColumnInfo[];
  /** 已暂存的新行回填；key 不存在表示「默认」 */
  initial?: Record<string, string | null>;
  onCancel: () => void;
  onConfirm: (values: Record<string, string | null>) => void;
}

function isAutoColumn(c: ColumnInfo) {
  return c.auto_increment;
}

/** NOT NULL 且无默认值、且不由数据库自动生成的列，必须显式给值 */
function isRequired(c: ColumnInfo) {
  return !c.nullable && c.default_value === null && !isAutoColumn(c);
}

/** 这些类型的控件一旦选了「值」就必须有内容，空串会被数据库拒绝 */
function needsContent(c: ColumnInfo) {
  const kind = fieldKind(c.data_type, c.raw_type);
  return kind === "number" || kind === "date" || kind === "time" || kind === "datetime" || kind === "enum";
}

function initialModes(columns: ColumnInfo[], initial?: Record<string, string | null>) {
  const modes: Record<string, FieldMode> = {};
  const texts: Record<string, string> = {};
  for (const c of columns) {
    if (initial && c.name in initial) {
      const v = initial[c.name];
      modes[c.name] = v === null ? "null" : "value";
      texts[c.name] = v ?? "";
    } else {
      modes[c.name] = "default";
      texts[c.name] = c.data_type.toLowerCase() === "boolean" ? "0" : "";
    }
  }
  return { modes, texts };
}

export function InsertRowDialog({ open, columns, initial, onCancel, onConfirm }: Props) {
  const [modes, setModes] = useState<Record<string, FieldMode>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [hint, setHint] = useState<string | null>(null);

  // 每次打开都按当前列定义和已暂存内容重置
  useEffect(() => {
    if (!open) return;
    const next = initialModes(columns, initial);
    setModes(next.modes);
    setTexts(next.texts);
    setHint(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, columns, initial]);

  const missing = useMemo(
    () => columns.filter((c) => isRequired(c) && modes[c.name] !== "value").map((c) => c.name),
    [columns, modes],
  );

  const emptyButNeeded = useMemo(
    () =>
      columns
        .filter((c) => modes[c.name] === "value" && needsContent(c) && (texts[c.name] ?? "") === "")
        .map((c) => c.name),
    [columns, modes, texts],
  );

  const unspecified = columns.filter((c) => modes[c.name] === "default");
  const specifiedCount = columns.filter((c) => modes[c.name] !== "default").length;

  function setMode(c: ColumnInfo, mode: FieldMode) {
    setModes((prev) => ({ ...prev, [c.name]: mode }));
    if (mode === "value" && texts[c.name] === "" && fieldKind(c.data_type, c.raw_type) === "boolean") {
      setTexts((prev) => ({ ...prev, [c.name]: "0" }));
    }
  }

  function confirm() {
    if (missing.length > 0) {
      setHint(`请先填写必填字段：${missing.join("、")}`);
      return;
    }
    if (emptyButNeeded.length > 0) {
      setHint(`这些字段选了「值」但内容为空，请填写或改回「默认」/「NULL」：${emptyButNeeded.join("、")}`);
      return;
    }
    if (specifiedCount === 0) {
      setHint("至少指定一个字段，否则没有内容可以插入");
      return;
    }
    const values: Record<string, string | null> = {};
    for (const c of columns) {
      if (modes[c.name] === "value") values[c.name] = texts[c.name] ?? "";
      else if (modes[c.name] === "null") values[c.name] = null;
    }
    onConfirm(values);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-4" /> 新增行
          </DialogTitle>
          <DialogDescription>
            字段留空表示「不指定」，由数据库填默认值；共 {columns.length} 列，已指定 {specifiedCount} 列。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-auto pr-1">
          {columns.map((c) => {
            const kind = fieldKind(c.data_type, c.raw_type);
            const mode = modes[c.name] ?? "default";
            const required = isRequired(c);
            const auto = isAutoColumn(c);
            return (
              <div key={c.name} className="rounded-md border p-2">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs font-medium">{c.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{c.raw_type}</span>
                  {c.primary_key && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">主键</span>
                  )}
                  {auto && (
                    <span className="rounded bg-blue-50 px-1 text-[10px] text-blue-700">自增</span>
                  )}
                  {!c.nullable && !auto && (
                    <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-700">非空</span>
                  )}
                  {c.default_value !== null && (
                    <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                      默认 {c.default_value}
                    </span>
                  )}
                  {required && <span className="text-[10px] text-destructive">必填</span>}
                  <div className="ml-auto flex overflow-hidden rounded border text-[11px]">
                    <button
                      type="button"
                      className={cn("px-2 py-0.5", mode === "default" ? "bg-foreground text-background" : "text-muted-foreground")}
                      onClick={() => setMode(c, "default")}
                    >
                      默认
                    </button>
                    <button
                      type="button"
                      disabled={!c.nullable || auto}
                      title={!c.nullable ? "该列不允许 NULL" : undefined}
                      className={cn(
                        "border-l px-2 py-0.5",
                        mode === "null" ? "bg-foreground text-background" : "text-muted-foreground",
                        (!c.nullable || auto) && "cursor-not-allowed opacity-40",
                      )}
                      onClick={() => setMode(c, "null")}
                    >
                      NULL
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "border-l px-2 py-0.5",
                        mode === "value" ? "bg-foreground text-background" : "text-muted-foreground",
                      )}
                      onClick={() => setMode(c, "value")}
                    >
                      值
                    </button>
                  </div>
                </div>

                {mode === "default" ? (
                  <div className="rounded-md border border-dashed bg-muted/30 px-2 py-1.5 font-mono text-xs text-muted-foreground">
                    {auto
                      ? "由数据库自动生成"
                      : c.default_value !== null
                        ? `使用默认值 ${c.default_value}`
                        : required
                          ? "该列没有默认值，请选择「值」"
                          : "不指定该列"}
                  </div>
                ) : (
                  <FieldInput
                    kind={kind}
                    text={texts[c.name] ?? ""}
                    isNull={mode === "null"}
                    enumValues={kind === "enum" || kind === "set" ? parseEnumValues(c.raw_type) : []}
                    onChange={(v) => setTexts((prev) => ({ ...prev, [c.name]: v }))}
                    textareaClassName="h-20"
                    placeholder={kind === "text" || kind === "json" ? `输入 ${kind === "json" ? "JSON" : "文本"}…` : undefined}
                  />
                )}

                {kind === "binary" && required && (
                  <div className="mt-1 text-[11px] text-destructive">
                    二进制列不支持在这里填写，请改用 SQL 插入
                  </div>
                )}

                {(kind === "json" || kind === "text") && mode === "value" && (
                  <button
                    type="button"
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      if (kind !== "json") return;
                      try {
                        setTexts((prev) => ({
                          ...prev,
                          [c.name]: JSON.stringify(JSON.parse(prev[c.name] ?? ""), null, 2),
                        }));
                        setHint(null);
                      } catch {
                        setHint(`${c.name} 不是合法的 JSON，无法格式化`);
                      }
                    }}
                  >
                    <WandSparkles className="size-3" /> 格式化
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {hint && <div className="text-xs text-destructive">{hint}</div>}
        {unspecified.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            将不指定：{unspecified.map((c) => c.name).join("、")}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" onClick={confirm}>
            暂存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
