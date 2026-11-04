import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Database, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { ConnectionConfig, SchemaGraph } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onPicked: (picked: {
    connectionId: string;
    database: string;
    graph: SchemaGraph;
    flavor: ConnectionConfig["flavor"];
    label: string;
  }) => void;
}

/** 从 PDM 侧发起对比：先选连接，再选库，然后拉库结构交给对比面板 */
export function CompareDbDialog({ open, onClose, onPicked }: Props) {
  const storeConnections = useAppStore((s) => s.connections);
  const [connections, setConnections] = useState<ConnectionConfig[]>(storeConnections);
  const [connectionId, setConnectionId] = useState("");
  const [databases, setDatabases] = useState<string[]>([]);
  const [database, setDatabase] = useState("");
  const [busy, setBusy] = useState(false);

  // 从 PDM 视图直接打开时 store 里可能还没有连接列表
  useEffect(() => {
    if (!open) return;
    if (storeConnections.length > 0) {
      setConnections(storeConnections);
      return;
    }
    void api
      .listConnections()
      .then(setConnections)
      .catch((e) => toast.error("读取连接失败", { description: String(e) }));
  }, [open, storeConnections]);

  // 选连接 → 连上 → 拉库列表
  useEffect(() => {
    if (!open || !connectionId) return;
    let cancelled = false;
    setBusy(true);
    setDatabases([]);
    setDatabase("");
    void (async () => {
      try {
        await api.connect(connectionId);
        const list = await api.listDatabases(connectionId);
        if (cancelled) return;
        setDatabases(list);
        setDatabase(list[0] ?? "");
      } catch (e) {
        if (!cancelled) toast.error("连接失败", { description: String(e), duration: 10000 });
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connectionId]);

  async function start() {
    if (!connectionId || !database) return;
    const conn = connections.find((c) => c.id === connectionId);
    setBusy(true);
    try {
      const graph = await api.schemaGraph(connectionId, database);
      onPicked({
        connectionId,
        database,
        graph,
        flavor: conn?.flavor ?? "mysql",
        label: `${conn?.name ?? connectionId}/${database}`,
      });
      onClose();
    } catch (e) {
      toast.error("读取库结构失败", { description: String(e), duration: 10000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="size-4" /> 对比数据库
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>连接</Label>
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选一个连接" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}（{c.flavor}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>库 / schema</Label>
            <Select value={database} onValueChange={setDatabase} disabled={databases.length === 0}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={busy ? "读取中…" : "选一个库"} />
              </SelectTrigger>
              <SelectContent>
                {databases.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            对比方向：**库是现状**，当前 PDM 是期望；生成的 ALTER 就是把库改成 PDM 的样子。
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={!connectionId || !database || busy} onClick={() => void start()}>
            {busy && <Loader2 className="size-4 animate-spin" />} 开始对比
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
