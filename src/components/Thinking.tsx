import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 思考过程默认只占一行：永远显示最后一行非空内容，换行时旧行向上滑出、新行从下滑入
 * （同一行的文字增长当打字机，不重播动画）。
 * 整套都**不带边框**，跟着所在容器的排版走。
 */
export function ThinkingLine({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== "") {
      idx = i;
      break;
    }
  }
  const line = idx >= 0 ? lines[idx].trim() : "";
  if (!line) return null;
  return (
    <div
      className={cn(
        "flex h-6 min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="shrink-0 opacity-50">·</span>
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={idx}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12, position: "absolute", inset: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="truncate"
          >
            {line}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** 展开后的思考过程全文：浅底色 + 可滚动，没有边框 */
export function ThinkingBody({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        "max-h-40 overflow-auto rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 whitespace-pre-wrap text-muted-foreground",
        className,
      )}
    >
      {text}
    </div>
  );
}

/** 「思考过程」展开 / 收起按钮 */
export function ThinkingToggle({
  open,
  onToggle,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      思考过程
      <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
    </button>
  );
}
