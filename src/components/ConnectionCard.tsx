import { useRef, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  Database,
  Loader2,
  MoreVertical,
  Pencil,
  PlugZap,
  SquareTerminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { useAppStore, type ConnStatus } from "@/store/app";
import type { ConnectionConfig, DbFlavor } from "@/lib/types";

const flavorLabel: Record<DbFlavor, string> = {
  mysql: "MySQL",
  mariadb: "MariaDB",
  tidb: "TiDB",
  sqlite: "SQLite",
  postgres: "PostgreSQL",
  oracle: "Oracle",
  redis: "Redis",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
};

function StatusLine({ status }: { status: ConnStatus }) {
  if (status === "testing") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 测试中…
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-emerald-600">
        <CheckCircle2 className="size-4" /> 连接正常
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-red-600">
        <XCircle className="size-4" /> 连接失败
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <CircleDashed className="size-4" /> 未测试
    </span>
  );
}

interface Props {
  config: ConnectionConfig;
  onEdit: (c: ConnectionConfig) => void;
  onRefresh: () => void;
}

export function ConnectionCard({ config, onEdit, onRefresh }: Props) {
  const { statuses, setStatus, setActiveId, setDatabases, setView, setResult, setError } = useAppStore();
  const [testing, setTesting] = useState(false);
  // 连点 / 双击「打开」时只跑一次，避免并发触发多次连接（也就不会一次弹好几个钥匙串授权框）
  const openingRef = useRef(false);
  const status: ConnStatus = statuses[config.id] ?? "untested";

  async function test() {
    setTesting(true);
    setStatus(config.id, "testing");
    try {
      await api.testSavedConnection(config.id);
      setStatus(config.id, "ok");
    } catch {
      setStatus(config.id, "error");
    } finally {
      setTesting(false);
    }
  }

  async function open() {
    if (openingRef.current) return;
    openingRef.current = true;
    try {
      setError(null);
      await api.connect(config.id);
      setActiveId(config.id);
      setDatabases(await api.listDatabases(config.id));
      setResult(null);
      setStatus(config.id, "ok");
      setView("workspace");
    } catch (e) {
      setStatus(config.id, "error");
      setError(String(e));
    } finally {
      openingRef.current = false;
    }
  }

  async function remove() {
    await api.deleteConnection(config.id);
    onRefresh();
  }

  return (
    <div className="flex flex-col rounded-xl border bg-card transition hover:border-ring/60 hover:shadow-sm">
      <button className="flex items-start gap-3 p-4 text-left" onClick={() => void open()}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Database className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{config.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
              {flavorLabel[config.flavor]}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted-foreground">
            {config.flavor === "sqlite"
              ? config.file_path || "未设置文件路径"
              : config.flavor === "oracle"
                ? `${config.username}@${config.host}:${config.port}${config.database ? `/${config.database}` : ""}`
                : `${config.username}@${config.host}:${config.port}`}
          </span>
        </span>
      </button>
      <div className="h-px bg-border" />
      <div className="flex items-center justify-between p-3">
        <StatusLine status={status} />
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost"><MoreVertical className="size-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void test()} disabled={testing}>
                <PlugZap className="size-4" /> 测试连接
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void open()}>
                <SquareTerminal className="size-4" /> 打开
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onEdit(config)}>
                <Pencil className="size-4" /> 编辑
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                <Trash2 className="size-4" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
