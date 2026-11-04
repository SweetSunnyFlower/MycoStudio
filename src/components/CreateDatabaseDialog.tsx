import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAppStore } from "@/store/app";
import type { DbFlavor } from "@/lib/types";

/** 常用字符集（MySQL 系），都能手输 */
const CHARSETS = ["utf8mb4", "utf8", "gbk", "gb18030", "big5", "latin1", "ascii"];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}

export function CreateDatabaseDialog({ open, onClose, onCreated }: Props) {
  const activeId = useAppStore((s) => s.activeId);
  const flavor: DbFlavor | undefined = useAppStore(
    (s) => s.connections.find((c) => c.id === s.activeId)?.flavor,
  );
  const isPg = flavor === "postgres";
  const isMysql = flavor === "mysql" || flavor === "mariadb" || flavor === "tidb";

  const [name, setName] = useState("");
  const [charset, setCharset] = useState("");
  const [collation, setCollation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCharset("");
    setCollation("");
    setError(null);
    setBusy(false);
  }, [open]);

  async function run() {
    if (!activeId || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createDatabase(
        activeId,
        name.trim(),
        isMysql ? charset || undefined : undefined,
        isMysql ? collation || undefined : undefined,
      );
      onCreated(name.trim());
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isPg ? "新建 Schema" : "新建数据库"}</DialogTitle>
          <DialogDescription>
            {isPg
              ? "在当前数据库里创建一个 schema（schema 就是工作台里的「库」）。"
              : "在服务器上创建一个数据库，创建后会自动出现在左侧列表里。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>{isPg ? "Schema 名" : "数据库名"}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isPg ? "如 analytics" : "如 my_app"}
              className="font-mono"
              autoFocus
            />
          </div>

          {isMysql && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>字符集（可选）</Label>
                <Select value={charset || "__default__"} onValueChange={(v) => setCharset(v === "__default__" ? "" : v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">默认</SelectItem>
                    {CHARSETS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>排序规则（可选）</Label>
                <Input
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  placeholder="如 utf8mb4_general_ci"
                  className="font-mono"
                />
              </div>
            </div>
          )}
        </div>

        {error && <div className="text-xs text-destructive [overflow-wrap:anywhere]">{error}</div>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={!name.trim() || busy} onClick={() => void run()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 创建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
