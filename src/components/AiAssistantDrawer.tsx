import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Dialog as DialogPrimitive } from "radix-ui";
import { toast } from "sonner";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Plus,
  Send,
  Settings2,
  Square,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cachedAiProviders, loadAiProviders } from "@/lib/aiProviders";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { AiProviders, ChatMessage, Conversation } from "@/lib/types";
import { MarkdownMessage } from "./MarkdownMessage";
import { ThinkingBody, ThinkingLine, ThinkingToggle } from "./Thinking";

const NO_PROVIDER = "还没有可用的 AI 供应商，先去「设置 → 供应商」添加";

interface Props {
  open: boolean;
  onClose: () => void;
  connectionId: string | null;
  database: string;
  table: string | null;
  /** 从 SQL 编辑器来的快捷指令：内容 + 递增的 nonce */
  seed: { text: string; nonce: number } | null;
  onInsertSql: (sql: string) => void;
  onOpenSettings: () => void;
}

/** 有默认供应商、且 token 与默认模型都不为空，才算「可以用」 */
function isReady(data: AiProviders | null): boolean {
  const p = data?.providers.find((x) => x.id === data.default_id);
  return !!p && p.token.trim().length > 0 && p.default_model.trim().length > 0;
}

export function AiAssistantDrawer({
  open,
  onClose,
  connectionId,
  database,
  table,
  seed,
  onInsertSql,
  onOpenSettings,
}: Props) {
  // 先用上次读到的配置（同步），避免刚打开抽屉就发问时被误判成「没配供应商」
  const [providers, setProviders] = useState<AiProviders | null>(() => cachedAiProviders());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState("");
  // 正在生成的思考过程（只保留本次流；落库后的历史从消息里读）
  const [streamReasoning, setStreamReasoning] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);

  // 事件回调里要判断「是不是当前会话」，用 ref 避免闭包拿到旧值
  const activeConv = useRef<string | null>(null);
  activeConv.current = activeId;
  /** 正在流式回答（事件回调里读，避免闭包拿到旧的 state） */
  const streamingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 是否贴底：用户往上翻历史时不要被流式增量一直拽回去 */
  const stickToBottom = useRef(true);
  const lastSeed = useRef(0);
  const sendRef = useRef<(t: string) => void>(() => {});

  const ready = isReady(providers);
  /** 当前生效的供应商（输入框下方那两颗 pill 显示它） */
  const activeProvider = providers?.providers.find((p) => p.id === providers.default_id) ?? null;

  /** 拉一次配置；返回结果，方便发送前就地判断 */
  async function loadProviders(force = false): Promise<AiProviders | null> {
    try {
      const data = await loadAiProviders(force);
      setProviders(data);
      return data;
    } catch (e) {
      toast.error("读取供应商失败", { description: String(e) });
      return null;
    }
  }

  async function loadConversations(selectFirst = true) {
    try {
      const list = await api.listAiConversations(connectionId);
      setConversations(list);
      // 只在还没选中任何会话时兜底选第一个：否则这个异步返回会把
      // 刚被快捷指令创建出来的会话切回去，连带把用户刚发的问题冲掉
      if (selectFirst) setActiveId((prev) => prev ?? list[0]?.id ?? null);
    } catch (e) {
      toast.error("读取会话失败", { description: String(e) });
    }
  }

  useEffect(() => {
    if (!open) return;
    // 打开时先按缓存判断能不能用，同时后台强制刷新一次
    void loadProviders(true);
    void loadConversations();
  }, [open, connectionId]);

  // 只在一个会话「第一次被打开」时加载消息；否则刚发出去的那条会被一次重新加载
  // 覆盖掉——用户会看到自己的问题"没上屏"
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (!activeId) {
      loadedFor.current = null;
      setMessages([]);
      return;
    }
    if (loadedFor.current === activeId) return;
    loadedFor.current = activeId;
    setLoading(true);
    api
      .aiConversationMessages(activeId)
      .then(setMessages)
      .catch((e) => toast.error("读取消息失败", { description: String(e) }))
      .finally(() => setLoading(false));
  }, [open, activeId]);

  // 流式事件
  useEffect(() => {
    let alive = true;
    const unlisten: UnlistenFn[] = [];
    // listen() 是异步的：组件若在它返回前就卸载了，旧监听器会一直留着，
    // 下次再打开抽屉就会叠加一份 —— 表现就是 AI 回复重复上屏
    const keep = (un: UnlistenFn) => {
      if (alive) unlisten.push(un);
      else un();
    };
    void listen<{ conversation_id: string; delta: string }>("ai://chunk", (e) => {
      if (e.payload.conversation_id !== activeConv.current) return;
      setStreamText((prev) => prev + e.payload.delta);
    }).then(keep);
    void listen<{ conversation_id: string; delta: string }>("ai://reasoning", (e) => {
      if (e.payload.conversation_id !== activeConv.current) return;
      setStreamReasoning((prev) => prev + e.payload.delta);
    }).then(keep);
    void listen<{ conversation_id: string; content: string; reasoning?: string }>("ai://done", (e) => {
      if (e.payload.conversation_id !== activeConv.current) return;
      // 不在本地追加，而是以数据库为准重新拉一次：
      // 万一 done 被重复投递，也只是多查一次，不会把回复叠成两条
      if (!streamingRef.current) return;
      streamingRef.current = false;
      setStreamText("");
      setStreamReasoning("");
      setStreaming(false);
      void reloadMessages(e.payload.conversation_id);
      void loadConversations(false);
    }).then(keep);
    void listen<{ conversation_id: string; message: string }>("ai://error", (e) => {
      if (e.payload.conversation_id !== activeConv.current) return;
      toast.error("AI 请求失败", { description: e.payload.message, duration: 10000 });
      streamingRef.current = false;
      setStreamText("");
      setStreamReasoning("");
      setStreaming(false);
    }).then(keep);
    return () => {
      alive = false;
      unlisten.forEach((un) => un());
    };
  }, []);

  /** 重新拉当前会话的消息（以库里的顺序与时间戳为准） */
  async function reloadMessages(id: string) {
    try {
      const list = await api.aiConversationMessages(id);
      if (activeConv.current === id) setMessages(list);
    } catch {
      // 忽略：界面上已经有流式内容了，拉不到就保持现状
    }
  }

  useEffect(() => {
    // 打开、消息变化、流式增量、加载完成，都跟到底部
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [open, messages, streamText, streamReasoning, loading]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function send(text: string) {
    const message = text.trim();
    // 用 ref 判断（state 在同一个 tick 里还是旧值，连点会漏过去发两次）
    if (!message || streamingRef.current) return;
    streamingRef.current = true;
    // 发送时一定跳到底部，不然刚发出去的问题会被自己翻走
    stickToBottom.current = true;
    // 配置还没读回来（比如刚打开抽屉就点了快捷指令）→ 等读完再判断，
    // 别把「还没读完」误报成「没配供应商」
    const data = providers ?? (await loadProviders(true));
    if (!isReady(data)) {
      streamingRef.current = false;
      toast.error(NO_PROVIDER);
      return;
    }
    try {
      let convId = activeId;
      if (!convId) {
        const created = await api.createAiConversation(connectionId, message.slice(0, 20));
        convId = created.id;
        activeConv.current = created.id;
        // 这个会话的消息由本地维护（下面这句就是第一条），别再回头加载把它冲掉
        loadedFor.current = created.id;
        setActiveId(created.id);
        setConversations((prev) => [created, ...prev]);
      }
      setMessages((prev) => [
        ...prev,
        { id: Date.now(), role: "user", content: message, reasoning: "", created_at: Date.now() },
      ]);
      setInput("");
      setStreamText("");
      setStreamReasoning("");
      setStreaming(true);
      await api.aiChatSend({
        conversationId: convId,
        connectionId,
        database: database || null,
        table,
        message,
      });
    } catch (e) {
      streamingRef.current = false;
      setStreaming(false);
      setStreamText("");
      setStreamReasoning("");
      toast.error("对话失败", { description: String(e), duration: 10000 });
    }
  }
  sendRef.current = send;

  // 来自 SQL 编辑器的快捷指令：直接发出去
  useEffect(() => {
    if (!open || !seed || seed.nonce === lastSeed.current) return;
    lastSeed.current = seed.nonce;
    void sendRef.current(seed.text);
  }, [open, seed]);

  async function removeConversation(id: string) {
    try {
      await api.deleteAiConversation(id);
      const list = conversations.filter((c) => c.id !== id);
      setConversations(list);
      if (activeId === id) setActiveId(list[0]?.id ?? null);
      toast.success("已删除会话");
    } catch (e) {
      toast.error("删除失败", { description: String(e) });
    }
  }

  function stop() {
    if (activeId) void api.aiChatCancel(activeId);
  }

  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? "新对话";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-0 right-0 z-50 flex h-full w-[520px] max-w-[94vw] flex-col border-l bg-popover text-sm text-popover-foreground shadow-lg outline-none",
            "duration-150 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          )}
        >
          <DialogPrimitive.Title className="sr-only">AI 助手</DialogPrimitive.Title>

          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <Bot className="size-4 shrink-0 text-muted-foreground" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="min-w-0 gap-1">
                  <span className="truncate">{activeTitle}</span>
                  <ChevronDown className="size-3.5 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-auto">
                <DropdownMenuItem onSelect={() => setActiveId(null)}>
                  <Plus className="size-4" /> 新对话
                </DropdownMenuItem>
                {conversations.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>历史会话</DropdownMenuLabel>
                {conversations.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无</div>
                ) : (
                  conversations.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onSelect={() => setActiveId(c.id)}
                      className="group/item justify-between gap-2"
                    >
                      <span className="truncate">{c.title || "未命名"}</span>
                      <span
                        role="button"
                        title="删除会话"
                        className="shrink-0 text-muted-foreground opacity-0 group-hover/item:opacity-100 hover:text-destructive"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void removeConversation(c.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto flex items-center gap-1">
              {table && <span className="truncate font-mono text-[11px] text-muted-foreground">{table}</span>}
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="关闭">
                  <X className="size-4" />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* 还没读到配置时不提示「没配供应商」，免得刚打开就闪一条吓人的警告 */}
          {providers !== null && !ready && (
            <div className="flex shrink-0 items-start gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
              <span className="flex-1">{NO_PROVIDER}</span>
              <Button size="xs" variant="outline" onClick={onOpenSettings}>
                <Settings2 className="size-3" /> 去设置
              </Button>
            </div>
          )}

          {/* 消息区：参考实现是 bg-muted/10 + p-6 的外层，内层 gap-5 */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto bg-muted/10 p-5"
          >
            <div className="mx-auto flex min-h-full flex-col gap-5">
            {loading ? (
              <div className="flex justify-center py-6 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : messages.length === 0 && !streamText ? (
              <div className="space-y-3 py-6 text-center">
                <Bot className="mx-auto size-8 text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">
                  问点什么吧，比如「查最近 7 天的订单」「users 表该加什么索引」
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {["这个库有哪些表，分别做什么用", "帮我写一条按天统计订单量的 SQL", "大表分页查询怎么写更快"].map(
                    (s) => (
                      <Button
                        key={s}
                        size="xs"
                        variant="outline"
                        disabled={!ready}
                        onClick={() => void send(s)}
                      >
                        {s}
                      </Button>
                    ),
                  )}
                </div>
              </div>
            ) : (
              <>
                {messages.map((m) => (
                  <MessageRow
                    key={m.id}
                    role={m.role}
                    content={m.content}
                    reasoning={m.reasoning}
                    createdAt={m.created_at}
                    onInsertSql={onInsertSql}
                  />
                ))}
                {streamText && (
                  <MessageRow
                    role="assistant"
                    content={streamText}
                    reasoning={streamReasoning}
                    createdAt={0}
                    onInsertSql={onInsertSql}
                    streaming
                  />
                )}
                {streaming && !streamText && !streamReasoning && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> 正在思考…
                  </div>
                )}
                {/* 还没出正文、但思考过程已经在滚：先让它自己占一个消息行的位置 */}
                {streaming && !streamText && streamReasoning && (
                  <MessageRow
                    role="assistant"
                    content=""
                    reasoning={streamReasoning}
                    createdAt={0}
                    onInsertSql={onInsertSql}
                    streaming
                  />
                )}
              </>
            )}
            </div>
          </div>

          <footer className="shrink-0 bg-muted/10 px-4 pt-2 pb-4">
            <div className="agent-composer rounded-[1.75rem] bg-card/85 p-2 shadow-[0_22px_70px_rgba(0,0,0,0.11)] ring-1 ring-border/55 backdrop-blur-xl transition duration-300 focus-within:ring-primary/20">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                placeholder={
                  providers === null
                    ? "正在读取供应商配置…"
                    : ready
                      ? "输入消息，Enter 发送，Shift + Enter 换行"
                      : "先去设置里添加供应商"
                }
                disabled={!ready}
                rows={3}
                className="max-h-72 min-h-24 resize-none rounded-[1.25rem] border-0 bg-transparent px-4 py-3 text-sm leading-6 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent"
              />
              <div className="mt-1 flex items-center justify-between gap-3 rounded-[1.15rem] bg-background/40 px-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  {activeProvider ? (
                    <>
                      <span className="max-w-[7rem] truncate rounded-xl bg-background/70 px-2.5 py-1 text-xs text-muted-foreground">
                        {activeProvider.name}
                      </span>
                      <span className="max-w-[9rem] truncate rounded-xl bg-background/70 px-2.5 py-1 font-mono text-xs text-muted-foreground">
                        {activeProvider.default_model || "未设模型"}
                      </span>
                    </>
                  ) : (
                    <span className="px-1 text-xs text-muted-foreground">未配置供应商</span>
                  )}
                </div>
                <div className="shrink-0">
                  {streaming ? (
                    <Button
                      size="icon"
                      variant="outline"
                      title="停止"
                      className="size-9 rounded-2xl"
                      onClick={stop}
                    >
                      <Square className="size-4" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      title="发送"
                      className="size-9 shrink-0 rounded-2xl shadow-sm transition duration-200 hover:-translate-y-px hover:shadow-md disabled:translate-y-0 disabled:shadow-none"
                      disabled={!ready || !input.trim()}
                      onClick={() => void send(input)}
                    >
                      <Send className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * 一条消息，照着 Comate 那套来：
 * 用户 = 右侧圆形头像 + 深色气泡；助手 = 左侧圆角方头像 + 浅色气泡；
 * 气泡下面一行是时间 + 复制（hover 才显形，复制成功变勾）。
 */
function MessageRow({
  role,
  content,
  reasoning,
  createdAt,
  onInsertSql,
  streaming,
}: {
  role: string;
  content: string;
  /** 模型的思考过程：默认一行，点开看全文（无边框） */
  reasoning?: string;
  createdAt: number;
  onInsertSql: (sql: string) => void;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  const [copied, setCopied] = useState(false);
  const [thinkOpen, setThinkOpen] = useState(false);
  const think = (reasoning ?? "").trim();

  function copy() {
    void copyText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className={cn("group flex w-full gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="agent-avatar mt-1 flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary/[0.07] text-primary">
          <Bot className="size-4" />
        </div>
      )}
      <div
        className={cn(
          "flex min-w-0 flex-col gap-1.5",
          // 助手这一侧铺满可用宽度：思考过程那一行要占满，「思考过程」四个字才固定在右边，
          // 不会随着思考内容变长而左右跑
          isUser ? "max-w-[min(78%,42rem)] items-end" : "w-full max-w-[min(84%,48rem)] items-start",
        )}
      >
        {!isUser && think !== "" && (
          <div className="flex w-full min-w-0 flex-col gap-1">
            <div className="flex w-full min-w-0 items-center gap-1">
              <div className="min-w-0 flex-1">{!thinkOpen && <ThinkingLine text={think} />}</div>
              <ThinkingToggle open={thinkOpen} onToggle={() => setThinkOpen((v) => !v)} className="shrink-0" />
            </div>
            {thinkOpen && <ThinkingBody text={think} className="w-full" />}
          </div>
        )}
        <div
          className={cn(
            "min-w-0 max-w-full text-sm",
            isUser
              ? "agent-message-card rounded-2xl rounded-br-md bg-primary px-3 py-2 text-primary-foreground shadow-sm shadow-primary/10"
              : "agent-message-card agent-message-card-assistant rounded-[1.35rem] rounded-bl-md bg-card/65 px-4 py-3 text-card-foreground backdrop-blur",
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{content}</p>
          ) : (
            <MarkdownMessage content={content} onInsertSql={onInsertSql} />
          )}
          {streaming && !content && (
            <div className="flex min-h-8 items-center gap-3 pr-2">
              <div className="space-y-1.5 text-left">
                <div className="text-xs font-medium text-foreground/85">正在组织回答</div>
                <div className="flex items-center gap-1.5">
                  <span className="agent-dot [animation-delay:0ms]" />
                  <span className="agent-dot [animation-delay:140ms]" />
                  <span className="agent-dot [animation-delay:280ms]" />
                </div>
              </div>
            </div>
          )}
        </div>
        {/* 生成中不显示时间与复制，等落库后再说 */}
        {!streaming && createdAt > 0 && (
          <div className={cn("flex items-center gap-1.5 px-1", isUser && "flex-row-reverse")}>
            <div className={cn("text-[11px]", isUser ? "text-muted-foreground/80" : "text-muted-foreground/80")}>
              {formatTime(createdAt)}
            </div>
            <button
              type="button"
              title="复制消息"
              className={cn(
                "flex size-7 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100",
                copied && "text-primary opacity-100",
              )}
              onClick={copy}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          </div>
        )}
      </div>
      {isUser && (
        <div className="agent-avatar mt-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
          <User className="size-4" />
        </div>
      )}
    </div>
  );
}

/** 2026-06-09 20:20:39 */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
