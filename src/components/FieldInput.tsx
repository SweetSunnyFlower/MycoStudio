import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { fromWidget, toWidget, type FieldKind } from "@/lib/field";

interface Props {
  kind: FieldKind;
  /** 存储文本（与数据库里存的值一致，不是控件的显示格式） */
  text: string;
  enumValues?: string[];
  /** true 表示当前是 NULL，控件清空并禁用 */
  isNull?: boolean;
  disabled?: boolean;
  onChange: (text: string) => void;
  /** 多行文本控件的高度类，默认 h-64 */
  textareaClassName?: string;
  placeholder?: string;
}

/** 按字段类型渲染对应的输入控件：日期用选择器、枚举用下拉、布尔用勾选框…… */
export function FieldInput({
  kind,
  text,
  enumValues = [],
  isNull = false,
  disabled = false,
  onChange,
  textareaClassName,
  placeholder,
}: Props) {
  const off = disabled || isNull;
  const value = isNull ? "" : toWidget(kind, text);

  if (kind === "number") {
    return (
      <input
        type="number"
        className="h-9 w-full rounded-md border bg-background px-2 font-mono text-sm outline-none focus-visible:border-ring disabled:opacity-60"
        value={value}
        disabled={off}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (kind === "boolean") {
    const on = text === "1" || text.toLowerCase() === "true";
    return (
      <label className="flex h-9 items-center gap-2 text-sm">
        <Checkbox
          checked={on}
          disabled={off}
          onCheckedChange={(v) => onChange(v === true ? "1" : "0")}
        />
        {on ? "true (1)" : "false (0)"}
      </label>
    );
  }

  if (kind === "date" || kind === "time" || kind === "datetime") {
    const type = kind === "datetime" ? "datetime-local" : kind;
    return (
      <input
        type={type}
        className="h-9 w-full rounded-md border bg-background px-2 font-mono text-sm outline-none focus-visible:border-ring disabled:opacity-60"
        value={value}
        disabled={off}
        onChange={(e) => onChange(fromWidget(kind, e.target.value))}
      />
    );
  }

  if (kind === "enum") {
    return (
      <Select value={value} onValueChange={onChange} disabled={off}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="选择枚举值" />
        </SelectTrigger>
        <SelectContent>
          {enumValues.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (kind === "set") {
    const selected = text.split(",").map((s) => s.trim()).filter(Boolean);
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 py-1.5">
        {enumValues.map((v) => {
          const on = selected.includes(v);
          return (
            <label key={v} className="flex items-center gap-1 text-xs">
              <Checkbox
                checked={on}
                disabled={off}
                className="size-3.5"
                onCheckedChange={() =>
                  onChange(on ? selected.filter((s) => s !== v).join(",") : [...selected, v].join(","))
                }
              />
              {v}
            </label>
          );
        })}
      </div>
    );
  }

  if (kind === "binary") {
    return (
      <div className="rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs text-muted-foreground">
        二进制内容，不支持编辑
      </div>
    );
  }

  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap outline-none focus-visible:border-ring disabled:opacity-60",
        textareaClassName ?? "h-64",
      )}
      value={isNull ? "" : text}
      disabled={off}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
