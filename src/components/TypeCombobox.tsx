import { useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** 常用列类型；只是候选，用户可以直接输入列表里没有的类型 */
export const COLUMN_TYPES = [
  "INT",
  "BIGINT",
  "SMALLINT",
  "TINYINT",
  "MEDIUMINT",
  "DECIMAL(10,2)",
  "NUMERIC(10,2)",
  "FLOAT",
  "DOUBLE",
  "VARCHAR(32)",
  "VARCHAR(64)",
  "VARCHAR(255)",
  "CHAR(36)",
  "TINYTEXT",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "DATE",
  "TIME",
  "DATETIME",
  "TIMESTAMP",
  "YEAR",
  "BOOLEAN",
  "JSON",
  "BLOB",
  "VARBINARY(255)",
  "ENUM('a','b')",
  "SET('a','b')",
];

/** Oracle 常用列类型（只是候选，可以直接输入别的） */
export const ORACLE_TYPES = [
  "NUMBER",
  "NUMBER(10)",
  "NUMBER(10,2)",
  "INTEGER",
  "FLOAT",
  "BINARY_DOUBLE",
  "VARCHAR2(32)",
  "VARCHAR2(64)",
  "VARCHAR2(255)",
  "VARCHAR2(4000)",
  "NVARCHAR2(255)",
  "CHAR(1)",
  "CLOB",
  "NCLOB",
  "BLOB",
  "RAW(16)",
  "DATE",
  "TIMESTAMP",
  "TIMESTAMP(6)",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP WITH LOCAL TIME ZONE",
  "INTERVAL DAY TO SECOND",
  "ROWID",
];

export function TypeCombobox({
  value,
  onChange,
  options = COLUMN_TYPES,
  className,
  placeholder = "选择或输入类型",
  disabled = false,
  onCommit,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: string[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 用户「确认」了一个值（回车选候选，或回车保留手输内容） */
  onCommit?: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const needle = value.trim().toLowerCase();
  const list = useMemo(
    () => (needle ? options.filter((t) => t.toLowerCase().includes(needle)) : options),
    [needle, options],
  );

  function choose(t: string) {
    onChange(t);
    onCommit?.(t);
    setOpen(false);
    setHighlight(-1);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setHighlight(-1);
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef} className={cn("relative", className)}>
          <Input
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            className="pr-7 font-mono"
            onChange={(e) => {
              onChange(e.target.value);
              setHighlight(-1);
              setOpen(true);
            }}
            onFocus={() => !disabled && setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setHighlight((i) => Math.min(i + 1, list.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((i) => Math.max(i - 1, 0));
              } else if (e.key === "Escape") {
                setOpen(false);
                setHighlight(-1);
              } else if (e.key === "Enter") {
                // 只有用方向键选中了某一项才会替换，否则保留手输的内容
                if (open && highlight >= 0 && list[highlight]) {
                  e.preventDefault();
                  choose(list[highlight]);
                } else {
                  setOpen(false);
                  if (value.trim()) onCommit?.(value.trim());
                }
              }
            }}
          />
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            className="absolute inset-y-0 right-1 flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="max-h-60 overflow-auto p-1"
        style={{ width: "var(--radix-popover-anchor-width, 14rem)" }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          // 点输入框本身（anchor）不要关掉下拉，否则没法边打字边看候选
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        {list.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            没有匹配的常用类型，直接回车保留你输入的类型
          </div>
        ) : (
          list.map((t, i) => (
            <button
              key={t}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(t)}
              className={cn(
                "flex w-full rounded px-2 py-1 text-left font-mono text-xs",
                i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                t === value && i !== highlight && "font-medium",
              )}
            >
              {t}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
