import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** react-markdown 给代码块塞进来的 <code class="language-xxx"> 属性 */
interface CodeProps {
  className?: string;
  children?: ReactNode;
}

/**
 * 助手回复按 Markdown 渲染（表格 / 列表 / 加粗都能出来）。
 * SQL 代码块额外挂一条工具行：复制 / 填入编辑器。
 */
export function MarkdownMessage({
  content,
  onInsertSql,
  className,
}: {
  content: string;
  onInsertSql?: (sql: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "chat-message-prose chat-message-prose-assistant prose prose-sm prose-neutral dark:prose-invert min-w-0 max-w-full text-left",
        "prose-p:my-1.5 prose-p:leading-7 prose-headings:mt-3 prose-headings:mb-2 prose-headings:font-semibold",
        "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-blockquote:my-2",
        "prose-code:rounded prose-code:bg-background/70 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-medium prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:my-0 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:border prose-pre:bg-background/70 prose-pre:p-3 prose-pre:text-sm",
        "prose-a:text-primary prose-a:underline-offset-4 hover:prose-a:underline",
        "prose-table:my-3 prose-th:border prose-th:px-2 prose-th:py-1 prose-td:border prose-td:px-2 prose-td:py-1",
        "[overflow-wrap:anywhere]",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock onInsertSql={onInsertSql}>{children}</CodeBlock>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({
  children,
  onInsertSql,
}: {
  children?: ReactNode;
  onInsertSql?: (sql: string) => void;
}) {
  const code = (children as { props?: CodeProps })?.props;
  const className = code?.className ?? "";
  const isSql = /language-sql/i.test(className);
  const text = String(code?.children ?? "").replace(/\n$/, "");

  if (!isSql) {
    return <pre>{children}</pre>;
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-background/60 px-2 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono">sql</span>
        <span className="flex gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
            onClick={() => {
              void copyText(text);
              toast.success("已复制 SQL");
            }}
          >
            <Copy className="size-3" />
          </button>
          {onInsertSql && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
              onClick={() => onInsertSql(text)}
            >
              填入编辑器
            </button>
          )}
        </span>
      </div>
      <pre className="my-0 overflow-x-auto bg-background/70 p-3 font-mono text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}
