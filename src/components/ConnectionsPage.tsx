import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { FileCode2, Plus, RefreshCw, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { ConnectionConfig } from "@/lib/types";
import { ConnectionCard } from "./ConnectionCard";
import { ConnectionDialog } from "./ConnectionDialog";

export function ConnectionsPage() {
  const { connections, setConnections, search, setSearch, setView, setStatus } = useAppStore();
  const reduce = useReducedMotion() ?? false;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  // 正在跑测试的连接，避免刷新 / 重进页面时对同一条重复发起
  const testingRef = useRef(new Set<string>());

  /** 进页面 / 点刷新都自动测一遍，最多 3 个并发，免得同时开一堆 SSH 隧道 */
  async function testAll(list: ConnectionConfig[]) {
    const queue = list.filter((c) => !testingRef.current.has(c.id));
    if (queue.length === 0) return;
    for (const c of queue) testingRef.current.add(c.id);
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        setStatus(next.id, "testing");
        try {
          await api.testSavedConnection(next.id);
          setStatus(next.id, "ok");
        } catch {
          setStatus(next.id, "error");
        } finally {
          testingRef.current.delete(next.id);
        }
      }
    });
    await Promise.all(workers);
  }

  async function refresh() {
    const list = await api.listConnections();
    setConnections(list);
    void testAll(list);
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q),
    );
  }, [connections, search]);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="px-8 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">连接管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">管理你的数据库连接</p>

        <div className="mt-5 flex items-center gap-3">
          <div className="relative w-80">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="搜索名称、主机或用户名"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <span className="text-sm text-muted-foreground">共 {filtered.length} 个连接</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="icon" variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="size-4" />
            </Button>
            <Button variant="outline" title="打开 PowerDesigner 的 .pdm 文件离线查看" onClick={() => setView("pdm")}>
              <FileCode2 className="size-4" /> 打开 PDM
            </Button>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="size-4" /> 新建连接
            </Button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c, i) => (
            <motion.div
              key={c.id}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reduce ? 0 : 0.2,
                delay: reduce ? 0 : Math.min(i, 8) * 0.03,
                ease: "easeOut",
              }}
            >
              <ConnectionCard
                config={c}
                onEdit={(x) => { setEditing(x); setDialogOpen(true); }}
                onRefresh={refresh}
              />
            </motion.div>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="mt-20 text-center text-sm text-muted-foreground">
            {connections.length === 0 ? "还没有连接，点击右上角「新建连接」开始" : "没有匹配的连接"}
          </div>
        )}
      </div>

      {dialogOpen && (
        <ConnectionDialog
          open
          initial={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={async () => { setDialogOpen(false); await refresh(); }}
        />
      )}

      <div className="fixed right-4 bottom-4 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          title="打开 PDM 文件"
          className="size-9 text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={() => setView("pdm")}
        >
          <FileCode2 className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="设置"
          className="size-9 text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={() => setView("settings")}
        >
          <Settings className="size-5" />
        </Button>
      </div>
    </div>
  );
}
