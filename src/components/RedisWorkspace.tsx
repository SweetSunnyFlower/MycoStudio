import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Clock3,
  Database,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { RedisEntry } from "@/lib/types";
import { useAppStore } from "@/store/app";
import { AiAssistantDrawer } from "./AiAssistantDrawer";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ThemeToggle } from "./ThemeToggle";

const TYPE_LABEL: Record<string, string> = {
  string: "字符串",
  hash: "哈希",
  list: "列表",
  set: "集合",
  zset: "有序集合",
  stream: "流",
};

function ttlText(ttl: number): string {
  if (ttl === -1) return "永不过期";
  if (ttl === -2) return "已过期";
  if (ttl < 60) return `${ttl} 秒`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)} 分钟`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)} 小时`;
  return `${Math.floor(ttl / 86400)} 天`;
}

function pretty(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** 命令补全用的 Redis 常用命令表（名字 + 参数 + 一句话说明） */
interface RedisCmdInfo {
  name: string;
  args: string;
  summary: string;
}

const REDIS_COMMANDS: RedisCmdInfo[] = [
  // 字符串
  { name: "GET", args: "key", summary: "取字符串值" },
  { name: "SET", args: "key value [EX 秒] [NX|XX]", summary: "设置字符串值" },
  { name: "SETEX", args: "key 秒 value", summary: "设值并带过期" },
  { name: "SETNX", args: "key value", summary: "不存在才设值" },
  { name: "GETSET", args: "key value", summary: "取旧值并设新值" },
  { name: "GETDEL", args: "key", summary: "取值并删除" },
  { name: "MGET", args: "key [key ...]", summary: "批量取值" },
  { name: "MSET", args: "key value [key value ...]", summary: "批量设值" },
  { name: "INCR", args: "key", summary: "自增 1" },
  { name: "DECR", args: "key", summary: "自减 1" },
  { name: "INCRBY", args: "key n", summary: "自增 n" },
  { name: "DECRBY", args: "key n", summary: "自减 n" },
  { name: "APPEND", args: "key value", summary: "末尾追加" },
  { name: "STRLEN", args: "key", summary: "值长度" },
  { name: "GETRANGE", args: "key start end", summary: "取子串" },
  { name: "SETRANGE", args: "key offset value", summary: "覆盖子串" },
  // key
  { name: "DEL", args: "key [key ...]", summary: "删除 key" },
  { name: "UNLINK", args: "key [key ...]", summary: "异步删除 key" },
  { name: "EXISTS", args: "key [key ...]", summary: "是否存在" },
  { name: "EXPIRE", args: "key 秒", summary: "设过期（秒）" },
  { name: "PEXPIRE", args: "key 毫秒", summary: "设过期（毫秒）" },
  { name: "TTL", args: "key", summary: "剩余过期秒数" },
  { name: "PTTL", args: "key", summary: "剩余过期毫秒" },
  { name: "PERSIST", args: "key", summary: "去掉过期时间" },
  { name: "TYPE", args: "key", summary: "key 的类型" },
  { name: "KEYS", args: "pattern", summary: "按模式找 key（慎用）" },
  { name: "SCAN", args: "cursor [MATCH p] [COUNT n]", summary: "游标遍历 key" },
  { name: "RANDOMKEY", args: "", summary: "随机返回一个 key" },
  { name: "RENAME", args: "key newkey", summary: "重命名" },
  { name: "DBSIZE", args: "", summary: "当前库 key 数量" },
  { name: "SELECT", args: "db", summary: "切换逻辑库" },
  // hash
  { name: "HSET", args: "key field value [field value ...]", summary: "设字段值" },
  { name: "HGET", args: "key field", summary: "取字段值" },
  { name: "HMSET", args: "key field value [field value ...]", summary: "批量设字段" },
  { name: "HMGET", args: "key field [field ...]", summary: "批量取字段" },
  { name: "HGETALL", args: "key", summary: "取所有字段和值" },
  { name: "HDEL", args: "key field [field ...]", summary: "删字段" },
  { name: "HEXISTS", args: "key field", summary: "字段是否存在" },
  { name: "HKEYS", args: "key", summary: "所有字段名" },
  { name: "HVALS", args: "key", summary: "所有字段值" },
  { name: "HLEN", args: "key", summary: "字段数量" },
  { name: "HINCRBY", args: "key field n", summary: "字段自增" },
  { name: "HSCAN", args: "key cursor", summary: "游标遍历字段" },
  // list
  { name: "LPUSH", args: "key value [value ...]", summary: "左侧插入" },
  { name: "RPUSH", args: "key value [value ...]", summary: "右侧插入" },
  { name: "LPOP", args: "key [count]", summary: "左侧弹出" },
  { name: "RPOP", args: "key [count]", summary: "右侧弹出" },
  { name: "LRANGE", args: "key start stop", summary: "取区间元素" },
  { name: "LLEN", args: "key", summary: "列表长度" },
  { name: "LINDEX", args: "key index", summary: "按下标取值" },
  { name: "LSET", args: "key index value", summary: "按下标改值" },
  { name: "LREM", args: "key count value", summary: "删指定元素" },
  { name: "LTRIM", args: "key start stop", summary: "裁剪列表" },
  { name: "LINSERT", args: "key BEFORE|AFTER pivot value", summary: "指定元素前后插入" },
  // set
  { name: "SADD", args: "key member [member ...]", summary: "加成员" },
  { name: "SREM", args: "key member [member ...]", summary: "删成员" },
  { name: "SMEMBERS", args: "key", summary: "所有成员" },
  { name: "SISMEMBER", args: "key member", summary: "是否成员" },
  { name: "SCARD", args: "key", summary: "成员数量" },
  { name: "SPOP", args: "key [count]", summary: "随机弹出" },
  { name: "SRANDMEMBER", args: "key [count]", summary: "随机取成员" },
  { name: "SINTER", args: "key [key ...]", summary: "交集" },
  { name: "SUNION", args: "key [key ...]", summary: "并集" },
  { name: "SDIFF", args: "key [key ...]", summary: "差集" },
  { name: "SSCAN", args: "key cursor", summary: "游标遍历成员" },
  // zset
  { name: "ZADD", args: "key score member [score member ...]", summary: "加成员（带分值）" },
  { name: "ZREM", args: "key member [member ...]", summary: "删成员" },
  { name: "ZSCORE", args: "key member", summary: "取分值" },
  { name: "ZINCRBY", args: "key n member", summary: "分值自增" },
  { name: "ZRANGE", args: "key start stop [WITHSCORES]", summary: "按排名取（升序）" },
  { name: "ZREVRANGE", args: "key start stop [WITHSCORES]", summary: "按排名取（降序）" },
  { name: "ZRANGEBYSCORE", args: "key min max [WITHSCORES]", summary: "按分值取" },
  { name: "ZRANK", args: "key member", summary: "升序排名" },
  { name: "ZREVRANK", args: "key member", summary: "降序排名" },
  { name: "ZCARD", args: "key", summary: "成员数量" },
  { name: "ZCOUNT", args: "key min max", summary: "分值区间计数" },
  { name: "ZSCAN", args: "key cursor", summary: "游标遍历成员" },
  // stream
  { name: "XADD", args: "key * field value [field value ...]", summary: "追加消息" },
  { name: "XLEN", args: "key", summary: "消息数量" },
  { name: "XRANGE", args: "key start end", summary: "取消息区间" },
  { name: "XREVRANGE", args: "key end start", summary: "倒序取消息" },
  { name: "XDEL", args: "key id [id ...]", summary: "删消息" },
  { name: "XTRIM", args: "key MAXLEN n", summary: "裁剪流" },
  { name: "XINFO", args: "STREAM key", summary: "流信息" },
  // 连接 / 服务
  { name: "PING", args: "", summary: "探活" },
  { name: "ECHO", args: "message", summary: "回显" },
  { name: "INFO", args: "[section]", summary: "服务器信息" },
  { name: "CONFIG", args: "GET|SET 参数", summary: "读写配置" },
  { name: "CLIENT", args: "LIST|GETNAME|...", summary: "客户端信息" },
  { name: "COMMAND", args: "[COUNT|DOCS]", summary: "命令元信息" },
  { name: "FLUSHDB", args: "[ASYNC]", summary: "清空当前库（慎用）" },
  { name: "FLUSHALL", args: "[ASYNC]", summary: "清空所有库（慎用）" },
  { name: "TIME", args: "", summary: "服务器时间" },
  { name: "LASTSAVE", args: "", summary: "上次存盘时间" },
  { name: "SAVE", args: "", summary: "同步存盘" },
  { name: "BGSAVE", args: "", summary: "后台存盘" },
  // 发布订阅 / 事务 / 脚本
  { name: "PUBLISH", args: "channel message", summary: "发布消息" },
  { name: "SUBSCRIBE", args: "channel [channel ...]", summary: "订阅频道" },
  { name: "PUBSUB", args: "CHANNELS|NUMSUB", summary: "发布订阅信息" },
  { name: "MULTI", args: "", summary: "开启事务" },
  { name: "EXEC", args: "", summary: "提交事务" },
  { name: "DISCARD", args: "", summary: "放弃事务" },
  { name: "WATCH", args: "key [key ...]", summary: "监视 key" },
  { name: "EVAL", args: "script numkeys key [arg ...]", summary: "执行 Lua 脚本" },
  { name: "SCRIPT", args: "LOAD|EXISTS|FLUSH", summary: "脚本管理" },
  // bitmap / hll / geo
  { name: "SETBIT", args: "key offset value", summary: "设位" },
  { name: "GETBIT", args: "key offset", summary: "取位" },
  { name: "BITCOUNT", args: "key [start end]", summary: "数 1 的个数" },
  { name: "PFADD", args: "key element [element ...]", summary: "HyperLogLog 添加" },
  { name: "PFCOUNT", args: "key [key ...]", summary: "HyperLogLog 估算基数" },
  { name: "GEOADD", args: "key 经度 纬度 member", summary: "加地理坐标" },
  { name: "GEODIST", args: "key member1 member2 [单位]", summary: "两点距离" },
  { name: "GEOPOS", args: "key member [member ...]", summary: "取坐标" },
];

export function RedisWorkspace() {
  const { activeId, connections, databases, setView, setError } = useAppStore();
  const active = connections.find((c) => c.id === activeId);

  const [database, setDatabase] = useState("");
  const [prefix, setPrefix] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [entry, setEntry] = useState<RedisEntry | null>(null);

  // string 编辑态
  const [editValue, setEditValue] = useState("");
  const [editTtl, setEditTtl] = useState("");
  const [saving, setSaving] = useState(false);

  // 命令行
  const [cmd, setCmd] = useState("");
  // 滚动回显：每条命令 + 它的结果，撑满可拖动的输出区
  const [logs, setLogs] = useState<{ cmd: string; out: string }[]>([]);
  const [cmdRunning, setCmdRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const cmdRef = useRef<HTMLTextAreaElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  // 上方面板展示什么：key 详情 / 命令结果
  const [contentMode, setContentMode] = useState<"key" | "output">("key");
  // 命令补全：高亮项 + 是否被 Esc 关掉
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  // 每个连接只在首次进入时自动扫一次 key，避免重复扫描
  const didInitialScan = useRef<string | null>(null);

  const [assistantOpen, setAssistantOpen] = useState(false);

  // 初始默认库
  useEffect(() => {
    setDatabase((prev) => {
      if (prev) return prev;
      const fromConn = active?.database ?? "";
      return databases.includes(fromConn) ? fromConn : (databases[0] ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, databases]);

  const activeDb = database || databases[0] || "0";

  useEffect(() => {
    setKeys([]);
    setCursor(0);
    setSelectedKey(null);
    setEntry(null);
  }, [activeDb]);

  useEffect(() => {
    if (!activeId) return;
    if (didInitialScan.current === activeId) return;
    didInitialScan.current = activeId;
    setKeys([]);
    setCursor(0);
    setSelectedKey(null);
    setEntry(null);
    void scan("", 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeDb]);

  // 切换 db：重连后重新扫描
  async function selectDb(db: string) {
    if (!activeId) return;
    setDatabase(db);
    setKeys([]);
    setCursor(0);
    setSelectedKey(null);
    setEntry(null);
    try {
      await api.redisSelectDb(activeId, db);
    } catch (e) {
      setError(String(e));
      return;
    }
    void scan("", 0);
  }

  async function scan(pfx: string, startCursor: number) {
    if (!activeId) return;
    setScanning(true);
    try {
      const res = await api.redisScan(activeId, pfx, startCursor, 200);
      setKeys((prev) => {
        const merged = new Set([...prev, ...res.keys]);
        return Array.from(merged).sort((a, b) => a.localeCompare(b));
      });
      setCursor(res.next_cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function refreshKeys() {
    setKeys([]);
    setSelectedKey(null);
    setEntry(null);
    await scan(prefix, 0);
  }

  async function loadMore() {
    if (cursor === 0) return;
    await scan(prefix, cursor);
  }

  async function loadEntry(key: string) {
    if (!activeId) return;
    setSelectedKey(key);
    setContentMode("key");
    try {
      const e = await api.redisEntry(activeId, key);
      setEntry(e);
      setEditValue(typeof e.value === "string" ? e.value : pretty(e.value));
      setEditTtl(e.ttl === -1 ? "" : String(e.ttl));
    } catch (err) {
      setError(String(err));
    }
  }

  async function saveString() {
    if (!activeId || !selectedKey) return;
    setSaving(true);
    try {
      const ttl = editTtl.trim() === "" ? null : Number(editTtl);
      await api.redisSetString(activeId, selectedKey, editValue, ttl);
      await loadEntry(selectedKey);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteKey() {
    if (!activeId || !selectedKey) return;
    await api.redisDelete(activeId, selectedKey);
    setSelectedKey(null);
    setEntry(null);
    await refreshKeys();
  }

  async function expireKey() {
    if (!activeId || !selectedKey) return;
    const seconds = Number(editTtl);
    if (Number.isNaN(seconds) || seconds < 0) {
      setError("请输入一个非负的过期秒数");
      return;
    }
    await api.redisExpire(activeId, selectedKey, seconds);
    await loadEntry(selectedKey);
  }

  async function runCommand() {
    const statement = cmd.trim();
    const args = statement.split(/\s+/).filter(Boolean);
    if (args.length === 0 || !activeId) return;
    setCmdRunning(true);
    let out: string;
    try {
      out = pretty(await api.redisExec(activeId, args));
    } catch (e) {
      out = `(error) ${String(e)}`;
    }
    setLogs((l) => [...l, { cmd: statement, out }].slice(-100));
    setHistory((h) => [statement, ...h].slice(0, 50));
    setHistIdx(-1);
    setCmd("");
    setContentMode("output");
    setCmdRunning(false);
    cmdRef.current?.focus();
  }

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  // 输入补全：第一个词补命令，后面补当前库已扫到的 key
  const suggestions = useMemo(() => {
    const current = cmd.split(/\s+/).slice(-1)[0] ?? "";
    if (current === "") return [];
    const hasSpace = /\s/.test(cmd);
    if (!hasSpace) {
      const q = current.toUpperCase();
      return REDIS_COMMANDS.filter((c) => c.name.startsWith(q))
        .slice(0, 8)
        .map((c) => ({
          kind: "command" as const,
          name: c.name,
          detail: `${c.args}  ${c.summary}`.trim(),
        }));
    }
    // 参数位置 → 补当前库已扫到的 key
    return keys
      .filter((k) => k.startsWith(current))
      .slice(0, 8)
      .map((k) => ({ kind: "key" as const, name: k, detail: "key" }));
  }, [cmd, keys]);

  const suggestOpen = suggestions.length > 0 && !suggestDismissed;

  function acceptSuggestion(name: string, isCommand: boolean) {
    const suffix = isCommand ? " " : "";
    setCmd((c) => {
      if (c.trim() === "" || /\s$/.test(c)) return `${c}${name}${suffix}`;
      return c.replace(/\S+$/, `${name}${suffix}`);
    });
    // 补全后就收起候选，别一直挂着；下次手动输入时再重新弹出
    setSuggestIdx(0);
    setSuggestDismissed(true);
    cmdRef.current?.focus();
  }

  const isString = entry?.key_type === "string";
  const filteredKeys = useMemo(() => keys, [keys]);

  // 两处长列表都虚拟化，只渲染可视区
  const keyScroller = useRef<HTMLDivElement | null>(null);
  const keyVirtualizer = useVirtualizer({
    count: filteredKeys.length,
    getScrollElement: () => keyScroller.current,
    estimateSize: () => 30,
    overscan: 8,
  });
  const logScroller = useRef<HTMLDivElement | null>(null);
  const logVirtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => logScroller.current,
    // 回显每条高度不一样，先估一个，再靠 measureElement 实测纠正
    estimateSize: () => 56,
    overscan: 6,
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => setView("connections")}>
          <ArrowLeft className="size-4" /> 返回
        </Button>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Database className="size-4" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm leading-tight font-semibold">{active?.name ?? "Redis"}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {active?.host}:{active?.port} · Redis
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant={assistantOpen ? "secondary" : "ghost"}
            title="AI 助手"
            onClick={() => setAssistantOpen((v) => !v)}
          >
            <Sparkles className="size-3.5" /> AI
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <div className="space-y-2 border-b p-3">
            <Label className="text-xs text-muted-foreground">数据库</Label>
            <Select value={activeDb} onValueChange={selectDb}>
              <SelectTrigger className="w-full font-mono"><SelectValue /></SelectTrigger>
              <SelectContent>
                {databases.map((db) => (
                  <SelectItem key={db} value={db}>
                    db{db}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-7 font-mono"
                  placeholder="前缀，如 user:*"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void refreshKeys()}
                />
              </div>
              <Button size="icon-sm" variant="outline" onClick={() => void refreshKeys()}>
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          </div>

          <div ref={keyScroller} className="min-h-0 flex-1 overflow-y-auto">
            {filteredKeys.length === 0 && !scanning && (
              <div className="p-4 text-center text-xs text-muted-foreground">没有匹配的 key</div>
            )}
            {/* 绝对定位 + 总高度占位：只有可视区的 key 进 DOM */}
            <div className="relative" style={{ height: keyVirtualizer.getTotalSize() }}>
              {keyVirtualizer.getVirtualItems().map((vi) => {
                const key = filteredKeys[vi.index];
                return (
                  <button
                    key={key}
                    ref={keyVirtualizer.measureElement}
                    data-index={vi.index}
                    onClick={() => void loadEntry(key)}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                    className={cn(
                      "flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left font-mono text-xs transition hover:bg-muted",
                      selectedKey === key && "bg-muted text-foreground",
                    )}
                  >
                    <KeyRound className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{key}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t p-2">
            {/*
              cursor 归零 = SCAN 已经遍历完，没有下一页了。
              这时留一个灰着的「加载更多」会让人以为点坏了，直接换成一句说明。
            */}
            {cursor === 0 && !scanning ? (
              <p className="text-center text-xs text-muted-foreground">
                已全部加载（{filteredKeys.length} 个 key）
              </p>
            ) : (
              <Button variant="ghost" size="sm" className="w-full" disabled={scanning} onClick={() => void loadMore()}>
                {scanning ? <Loader2 className="size-3.5 animate-spin" /> : null}
                加载更多
              </Button>
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel className="flex min-h-0 flex-col" style={{ overflow: "hidden" }}>
              {contentMode === "output" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-9 shrink-0 items-center gap-2 border-b px-4 text-sm">
                    <Terminal className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">命令结果</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">db{activeDb}</span>
                    <div className="ml-auto">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={logs.length === 0}
                        onClick={() => setLogs([])}
                      >
                        <Trash2 className="size-3" /> 清空
                      </Button>
                    </div>
                  </div>
                  <div ref={logScroller} className="min-h-0 flex-1 overflow-auto font-mono text-xs">
                    {logs.length === 0 ? (
                      <div className="flex h-full items-center justify-center font-sans text-sm text-muted-foreground">
                        还没有执行过命令
                      </div>
                    ) : (
                      <div className="relative" style={{ height: logVirtualizer.getTotalSize() }}>
                        {logVirtualizer.getVirtualItems().map((vi) => {
                          const l = logs[vi.index];
                          return (
                            <div
                              key={vi.index}
                              ref={logVirtualizer.measureElement}
                              data-index={vi.index}
                              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                              className="border-b border-border/40 px-4 py-2"
                            >
                              <div className="flex items-start gap-1.5 text-muted-foreground">
                                <span className="shrink-0">db{activeDb} &gt;</span>
                                <span className="break-all whitespace-pre-wrap">{l.cmd}</span>
                              </div>
                              <pre className="break-all whitespace-pre-wrap text-foreground">{l.out}</pre>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div ref={logEndRef} />
                  </div>
                </div>
              ) : !entry ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  选择一个 key 查看详情
                </div>
              ) : (
                <>
                  <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
                    <KeyRound className="size-4 text-muted-foreground" />
                    <span className="truncate font-mono text-sm font-medium">{entry.key}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {TYPE_LABEL[entry.key_type] ?? entry.key_type}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock3 className="size-3" /> {ttlText(entry.ttl)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.size} {entry.key_type === "string" ? "字节" : "个元素"}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      {isString && (
                        <Button size="sm" variant="outline" disabled={saving} onClick={() => void saveString()}>
                          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                          保存
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => void expireKey()}>
                        <Clock3 className="size-3.5" /> 设置 TTL
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void deleteKey()}>
                        <Trash2 className="size-3.5 text-destructive" /> 删除
                      </Button>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-auto p-4">
                    {isString ? (
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">值（字符串）</Label>
                        <Textarea
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="min-h-40 font-mono text-xs"
                          spellCheck={false}
                        />
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground">TTL（秒，留空永不过期）</Label>
                          <Input
                            value={editTtl}
                            onChange={(e) => setEditTtl(e.target.value)}
                            className="w-32 font-mono text-xs"
                            placeholder="-1"
                          />
                        </div>
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
                        {pretty(entry.value)}
                      </pre>
                    )}
                  </div>
                </>
              )}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={240}
              groupResizeBehavior="preserve-pixel-size"
              className="flex min-h-0 flex-col"
              style={{ overflow: "hidden" }}
            >
              <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
                <Terminal className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium">Redis 命令行</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">db{activeDb}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button size="xs" disabled={cmdRunning} onClick={() => void runCommand()}>
                    {cmdRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Terminal className="size-3" />}
                    运行
                  </Button>
                </div>
              </div>
              <div className="relative min-h-0 flex-1">
                <textarea
                  ref={cmdRef}
                  value={cmd}
                  onChange={(e) => {
                    setCmd(e.target.value);
                    setSuggestIdx(0);
                    setSuggestDismissed(false);
                  }}
                  onKeyDown={(e) => {
                    if (suggestOpen) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSuggestIdx((i) => Math.min(i + 1, suggestions.length - 1));
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSuggestIdx((i) => Math.max(i - 1, 0));
                        return;
                      }
                      if (e.key === "Tab") {
                        e.preventDefault();
                        const s = suggestions[suggestIdx];
                        if (s) acceptSuggestion(s.name, s.kind === "command");
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSuggestDismissed(true);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void runCommand();
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      if (history.length === 0) return;
                      const next = histIdx < 0 ? 0 : Math.min(histIdx + 1, history.length - 1);
                      setHistIdx(next);
                      setCmd(history[next]);
                      setSuggestDismissed(true);
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      if (histIdx < 0) return;
                      const next = histIdx - 1;
                      setHistIdx(next);
                      setCmd(next >= 0 ? history[next] : "");
                      setSuggestDismissed(true);
                    }
                  }}
                  placeholder="如 GET key、HGETALL key、SCAN 0"
                  spellCheck={false}
                  className="h-full min-h-0 w-full resize-none bg-transparent px-3 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground"
                />
                {suggestOpen && (
                  <div className="absolute top-1 left-3 z-20 w-[26rem] max-w-[calc(100%-1.5rem)] overflow-hidden rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md">
                    {suggestions.map((s, i) => (
                      <button
                        key={s.name}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          acceptSuggestion(s.name, s.kind === "command");
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs",
                          i === suggestIdx ? "bg-muted" : "hover:bg-muted/60",
                        )}
                      >
                        <span className="w-24 shrink-0 truncate font-medium">{s.name}</span>
                        <span className="truncate text-muted-foreground">{s.detail}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </main>
      </div>

      <AiAssistantDrawer
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        connectionId={activeId}
        database={activeDb}
        table={null}
        seed={null}
        onInsertSql={(sql) => {
          setCmd(sql);
          cmdRef.current?.focus();
        }}
        onOpenSettings={() => setView("settings")}
      />
    </div>
  );
}
