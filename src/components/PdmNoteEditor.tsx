import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { Markdown } from "tiptap-markdown";
import { Check, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SlashItem {
  title: string;
  hint: string;
  keywords: string;
  run: (editor: Editor) => void;
}

/** 斜杠命令（Notion 那种输入 / 弹出来的块菜单） */
const SLASH_ITEMS: SlashItem[] = [
  {
    title: "正文",
    hint: "普通段落",
    keywords: "text paragraph p",
    run: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    title: "标题 1",
    hint: "大标题",
    keywords: "h1 title heading",
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    title: "标题 2",
    hint: "中标题",
    keywords: "h2 heading",
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    title: "标题 3",
    hint: "小标题",
    keywords: "h3 heading",
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    title: "无序列表",
    hint: "圆点列表",
    keywords: "ul bullet list",
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    title: "有序列表",
    hint: "数字列表",
    keywords: "ol ordered list",
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    title: "引用",
    hint: "引用一段话",
    keywords: "quote blockquote",
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    title: "代码块",
    hint: "等宽代码",
    keywords: "code block pre",
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    title: "分割线",
    hint: "分隔内容",
    keywords: "hr line divider",
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
];

/** 斜杠菜单：跟着光标定位的浮层（自己管 DOM，避免每个字段都挂 React 编辑器） */
function slashRenderer() {
  let popup: HTMLDivElement | null = null;
  let current: SuggestionProps<SlashItem, SlashItem> | null = null;
  let index = 0;

  const exit = () => {
    popup?.remove();
    popup = null;
    current = null;
    index = 0;
  };

  const list = () => current?.items ?? [];

  const paint = () => {
    if (!popup || !current) return;
    popup.replaceChildren();
    const items = list();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "px-2.5 py-2 text-xs text-muted-foreground";
      empty.textContent = "没有匹配的命令";
      popup.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm " +
        (i === index ? "bg-muted text-foreground" : "text-popover-foreground");
      const title = document.createElement("span");
      title.className = "font-medium";
      title.textContent = item.title;
      const hint = document.createElement("span");
      hint.className = "ml-auto text-xs text-muted-foreground";
      hint.textContent = item.hint;
      row.append(title, hint);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        current?.command(item);
      });
      popup!.appendChild(row);
    });
  };

  const place = () => {
    if (!popup || !current) return;
    const rect = current.clientRect?.();
    const width = 224;
    const left = rect ? Math.min(rect.left, window.innerWidth - width - 12) : 12;
    const top = rect ? Math.min(rect.bottom + 6, window.innerHeight - 320) : 12;
    popup.style.left = `${Math.max(8, left)}px`;
    popup.style.top = `${Math.max(8, top)}px`;
  };

  return {
    onStart: (props: SuggestionProps<SlashItem, SlashItem>) => {
      current = props;
      index = 0;
      popup = document.createElement("div");
      popup.setAttribute("data-pdm-slash-menu", "");
      popup.className =
        "fixed z-[1000] max-h-72 w-56 overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
      document.body.appendChild(popup);
      place();
      paint();
    },
    onUpdate: (props: SuggestionProps<SlashItem, SlashItem>) => {
      current = props;
      index = 0;
      place();
      paint();
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const items = list();
      if (items.length === 0) return false;
      if (event.key === "ArrowDown") {
        index = (index + 1) % items.length;
        paint();
        return true;
      }
      if (event.key === "ArrowUp") {
        index = (index - 1 + items.length) % items.length;
        paint();
        return true;
      }
      if (event.key === "Enter") {
        current?.command(items[index]);
        return true;
      }
      if (event.key === "Escape") {
        exit();
        return true;
      }
      return false;
    },
    onExit: exit,
  };
}

const SlashCommand = Extension.create({
  name: "pdmSlashCommand",
  addOptions() {
    return {
      suggestion: {
        char: "/",
        // 允许在任何位置触发（默认只认空格后的 /）
        allowedPrefixes: null,
        startOfLine: false,
        items: ({ query }: { query: string }) => {
          const q = query.trim().toLowerCase();
          if (!q) return SLASH_ITEMS;
          return SLASH_ITEMS.filter((i) =>
            `${i.title} ${i.hint} ${i.keywords}`.toLowerCase().includes(q),
          );
        },
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: { from: number; to: number };
          props: SlashItem;
        }) => {
          editor.chain().focus().deleteRange(range).run();
          props.run(editor);
        },
        render: slashRenderer,
      },
    };
  },
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })];
  },
});

const EDITOR_CLASS = cn(
  "prose prose-sm prose-neutral dark:prose-invert max-w-none min-h-24 outline-none",
  "prose-p:my-1.5 prose-headings:my-2 prose-headings:font-semibold",
  "prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-blockquote:my-1.5",
  "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal",
  "prose-code:before:content-none prose-code:after:content-none",
  "prose-pre:my-1 prose-pre:rounded-lg prose-pre:border prose-pre:bg-muted prose-pre:p-2 prose-pre:text-xs",
);

/** tiptap-markdown 没给 storage 补类型，这里收口一下 */
function editorMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as {
    markdown?: { getMarkdown(): string };
  };
  return storage.markdown?.getMarkdown() ?? "";
}

export interface PdmNoteTarget {
  table: string;
  column: string;
  anchor: DOMRect;
}

interface Props {
  target: PdmNoteTarget;
  initial: string;
  onSave: (markdown: string) => void;
  onClose: () => void;
}

/** 字段笔记浮层：Tiptap 无头编辑器 + 斜杠命令，内容按 markdown 保存 */
export function PdmNoteEditor({ target, initial, onSave, onClose }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Markdown.configure({ html: false, tightLists: true, breaks: true }),
      SlashCommand,
    ],
    content: initial,
    autofocus: "end",
    editorProps: { attributes: { class: EDITOR_CLASS } },
  });

  const latest = useRef(initial);
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      latest.current = editorMarkdown(editor);
    };
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor]);

  // 关闭（点外面 / 完成 / 切走）时统一保存一次
  useEffect(() => {
    return () => {
      if (latest.current !== initial) saveRef.current(latest.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useMemo(() => {
    const width = 384;
    const gap = 10;
    const a = target.anchor;
    let left = a.right + gap;
    if (left + width > window.innerWidth - 8) left = a.left - width - gap;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(a.top - 36, window.innerHeight - 440));
    return { left, top, width };
  }, [target]);

  // 用 portal 挂到 body：视图外层有 motion 的 transform，直接用 fixed 会被当成相对祖先定位
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="fixed z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
        style={{ left: style.left, top: style.top, width: style.width, transformOrigin: "top left" }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <StickyNote className="size-3.5 shrink-0 text-sky-500" />
          <span className="truncate font-mono text-xs font-medium">
            {target.table}.{target.column}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            输入 <span className="font-mono">/</span> 插入块
          </span>
          <Button size="icon-xs" variant="ghost" title="关闭" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <EditorContent editor={editor} />
        </div>
        <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">自动保存 · Markdown</span>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => editor?.chain().focus().clearContent().run()}
            >
              <Trash2 className="size-3" /> 清空
            </Button>
            <Button size="xs" onClick={onClose}>
              <Check className="size-3" /> 完成
            </Button>
          </div>
        </div>
      </motion.div>
    </>,
    document.body,
  );
}
