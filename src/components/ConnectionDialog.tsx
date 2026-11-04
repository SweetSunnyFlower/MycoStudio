import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, ChevronRight, Eye, EyeOff, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ConnectionConfig, DbFlavor } from "@/lib/types";

const FLAVOR_LABEL: Record<DbFlavor, string> = {
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

const DEFAULT_PORTS: Partial<Record<DbFlavor, string>> = {
  mysql: "3306",
  mariadb: "3306",
  tidb: "4000",
  postgres: "5432",
  oracle: "1521",
  redis: "6379",
  mongodb: "27017",
  elasticsearch: "9200",
};

/** 各引擎的默认用户名。MongoDB / Redis / Elasticsearch 允许匿名访问，默认留空 */
const DEFAULT_USERNAMES: Partial<Record<DbFlavor, string>> = {
  mysql: "root",
  mariadb: "root",
  tidb: "root",
  postgres: "postgres",
};

/** 可以不带用户名连的引擎，输入框给一句提示，避免空着让人以为填漏了 */
const ANONYMOUS_HINT: Partial<Record<DbFlavor, string>> = {
  mongodb: "可留空（无鉴权实例）",
  redis: "Redis 通常为空",
  elasticsearch: "可留空（未开启安全模块）",
};

interface Props {
  open: boolean;
  initial: ConnectionConfig | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ConnectionDialog({ open, initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [flavor, setFlavor] = useState<DbFlavor>(initial?.flavor ?? "mysql");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(initial?.port || DEFAULT_PORTS.mysql));
  const [username, setUsername] = useState(
    initial?.username ?? DEFAULT_USERNAMES[initial?.flavor ?? "mysql"] ?? "",
  );
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(initial?.database ?? "");
  // Oracle：连接方式（服务名 / SID）+ 特权认证
  const [oracleConnType, setOracleConnType] = useState(initial?.oracle_conn_type ?? "service");
  const [oracleRole, setOracleRole] = useState(initial?.oracle_role ?? "");
  const [filePath, setFilePath] = useState(initial?.file_path ?? "");
  const [sslMode, setSslMode] = useState(initial?.ssl_mode ?? "preferred");
  const [sslCa, setSslCa] = useState(initial?.ssl_ca ?? "");
  const [sslCert, setSslCert] = useState(initial?.ssl_cert ?? "");
  const [sslKey, setSslKey] = useState(initial?.ssl_key ?? "");
  const [sshEnabled, setSshEnabled] = useState(initial?.ssh_enabled ?? false);
  const [sshHost, setSshHost] = useState(initial?.ssh_host ?? "");
  const [sshPort, setSshPort] = useState(String(initial?.ssh_port || 22));
  const [sshUser, setSshUser] = useState(initial?.ssh_user ?? "");
  const [sshAuthMethod, setSshAuthMethod] = useState(initial?.ssh_auth_method ?? "private_key");
  const [sshPrivateKeyPath, setSshPrivateKeyPath] = useState(initial?.ssh_private_key_path ?? "");
  const [sshPassword, setSshPassword] = useState("");
  // Elasticsearch：简单 HTTPS 开关（映射到 ssl_mode）
  const [esHttps, setEsHttps] = useState(
    initial?.ssl_mode === "required" ||
      initial?.ssl_mode === "verify_ca" ||
      initial?.ssl_mode === "verify_identity",
  );
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // 编辑已有连接时，如果它本来就用了 SSL / SSH，默认展开高级设置，避免看不到已配置的项
  const [advancedOpen, setAdvancedOpen] = useState(
    !!initial &&
      (!!initial.ssh_enabled ||
        !!initial.ssl_ca ||
        !!initial.ssl_cert ||
        !!initial.ssl_key ||
        (initial.ssl_mode != null && initial.ssl_mode !== "preferred")),
  );

  const isNew = !initial;
  const isSqlite = flavor === "sqlite";
  const isOracle = flavor === "oracle";
  const isRedis = flavor === "redis";
  const isMongo = flavor === "mongodb";
  const isEs = flavor === "elasticsearch";

  function build(): ConnectionConfig {
    if (isSqlite) {
      return {
        id: initial?.id ?? crypto.randomUUID(),
        name: name.trim() || "SQLite",
        host: "",
        port: 0,
        username: "",
        database: null,
        flavor: "sqlite",
        file_path: filePath.trim() || null,
        ssl_mode: null,
        ssl_ca: null,
        ssl_cert: null,
        ssl_key: null,
        ssh_enabled: false,
        ssh_host: "",
        ssh_port: 22,
        ssh_user: "",
        ssh_auth_method: null,
        ssh_private_key_path: null,
        oracle_conn_type: null,
        oracle_role: null,
      };
    }
    return {
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim() || "未命名连接",
      host: host.trim() || "127.0.0.1",
      port: Number(port) || (isOracle ? 1521 : isRedis ? 6379 : 3306),
      username: username.trim() || DEFAULT_USERNAMES[flavor] || "",
      database: database.trim() || null,
      flavor,
      file_path: null,
      ssl_mode: isEs ? (esHttps ? "required" : null) : sslMode || null,
      ssl_ca: sslCa.trim() || null,
      ssl_cert: sslCert.trim() || null,
      ssl_key: sslKey.trim() || null,
      ssh_enabled: sshEnabled,
      ssh_host: sshHost.trim(),
      ssh_port: Number(sshPort) || 22,
      ssh_user: sshUser.trim(),
      ssh_auth_method: sshAuthMethod || null,
      ssh_private_key_path: sshPrivateKeyPath.trim() || null,
      oracle_conn_type: isOracle ? oracleConnType : null,
      oracle_role: isOracle ? oracleRole || null : null,
    };
  }

  function changeFlavor(next: DbFlavor) {
    setFlavor(next);
    if (next !== "sqlite" && DEFAULT_PORTS[next]) setPort(DEFAULT_PORTS[next]!);
    // 用户名要跟着引擎走：MySQL 系默认 root、PostgreSQL 默认 postgres，
    // 其余引擎允许匿名，必须清空——否则会拿着 root 去连无鉴权的实例
    setUsername(DEFAULT_USERNAMES[next] ?? "");
    setTestResult(null);
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      // 密码留空时传 undefined：新建连接用空密码，编辑连接则由后端沿用已保存的密码
      await api.testConnection(build(), password || undefined, sshPassword || undefined);
      setTestResult({ ok: true, msg: "连接成功" });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const pwArg = isNew ? password : password || undefined;
    await api.saveConnection(build(), pwArg, sshPassword || undefined);
    onSaved();
  }

  async function pickFile(setter: (v: string) => void) {
    const f = await openDialog({ multiple: false });
    if (typeof f === "string") setter(f);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {isNew ? "新建连接" : "编辑连接"}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
              {FLAVOR_LABEL[flavor]}
            </span>
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            连接信息保存在本地；密码存本地 SQLite（明文，文件权限 600）。
          </p>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-4 overflow-y-auto pr-1">
          <div className="grid gap-1.5">
            <Label>名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="本地开发库" />
          </div>
          <div className="grid gap-1.5">
            <Label>引擎</Label>
            <Select value={flavor} onValueChange={(v) => changeFlavor(v as DbFlavor)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mysql">MySQL</SelectItem>
                <SelectItem value="mariadb">MariaDB</SelectItem>
                <SelectItem value="tidb">TiDB</SelectItem>
                <SelectItem value="sqlite">SQLite</SelectItem>
                <SelectItem value="postgres">PostgreSQL</SelectItem>
                <SelectItem value="oracle">Oracle（19c / 21c / 26ai）</SelectItem>
                <SelectItem value="redis">Redis</SelectItem>
                <SelectItem value="mongodb">MongoDB</SelectItem>
                <SelectItem value="elasticsearch">Elasticsearch</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isSqlite ? (
            <div className="col-span-2 grid gap-1.5">
              <Label>文件路径</Label>
              <Input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="如 /Users/you/data.db，文件不存在会自动创建"
                className="font-mono"
              />
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label>主机</Label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label>端口</Label>
                <Input value={port} onChange={(e) => setPort(e.target.value)} className="font-mono" />
              </div>

              <div className="grid gap-1.5">
                <Label>{isRedis ? "用户名（可选）" : "用户名"}</Label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder={ANONYMOUS_HINT[flavor]} />
              </div>
              <div className="grid gap-1.5">
                <Label>密码</Label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={isNew ? "" : "留空则不改"}
                    autoComplete="new-password"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              {isOracle ? (
                <>
                  <div className="grid gap-1.5">
                    <Label>连接方式</Label>
                    <Select value={oracleConnType} onValueChange={setOracleConnType}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="service">服务名（Service Name）</SelectItem>
                        <SelectItem value="sid">SID</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>特权认证</Label>
                    <Select value={oracleRole || "none"} onValueChange={(v) => setOracleRole(v === "none" ? "" : v)}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">普通用户</SelectItem>
                        <SelectItem value="SYSDBA">SYSDBA</SelectItem>
                        <SelectItem value="SYSOPER">SYSOPER</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2 grid gap-1.5">
                    <Label>{oracleConnType === "sid" ? "SID" : "服务名"}</Label>
                    <Input
                      value={database}
                      onChange={(e) => setDatabase(e.target.value)}
                      placeholder={oracleConnType === "sid" ? "如 ORCL" : "如 ORCLPDB1"}
                      className="font-mono"
                    />
                  </div>
                </>
              ) : isEs ? (
                <div className="col-span-2 grid gap-1.5">
                  <Label>连接协议</Label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={esHttps} onCheckedChange={(v) => setEsHttps(v === true)} />
                    使用 HTTPS（自签证书会自动跳过校验）
                  </label>
                </div>
              ) : (
                <div className="col-span-2 grid gap-1.5">
                  <Label>
                    {isRedis ? "数据库（可选，默认 0）" : isMongo ? "认证/默认库（可选，默认 admin）" : "默认数据库（可选）"}
                  </Label>
                  <Input
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder={
                      isRedis
                        ? "Redis 逻辑库序号，如 0"
                        : isMongo
                          ? "如 admin，留空则认证到 admin"
                          : "可选，打开工作台时默认选中"
                    }
                    className="font-mono"
                  />
                </div>
              )}

              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="col-span-2 flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
              >
                <ChevronRight
                  className={cn("size-4 transition-transform", advancedOpen && "rotate-90")}
                />
                {isOracle || isRedis || isMongo || isEs
                  ? "高级设置（SSH 隧道）"
                  : "高级设置（SSL / SSH）"}
              </button>

              {advancedOpen && (
                <>
                  {/* Oracle / Redis / MongoDB / ES 不显示 MySQL/PG 那套 SSL 配置 */}
                  {!isOracle && !isRedis && !isMongo && !isEs && (
                  <div className="col-span-2 grid gap-2 rounded-md border p-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label>SSL 模式</Label>
                        <Select value={sslMode} onValueChange={setSslMode}>
                          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="preferred">优先（默认）</SelectItem>
                            <SelectItem value="disabled">禁用</SelectItem>
                            <SelectItem value="required">必需</SelectItem>
                            <SelectItem value="verify_ca">校验 CA</SelectItem>
                            <SelectItem value="verify_identity">校验证书身份</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {(["sslCa", "sslCert", "sslKey"] as const).map((k) => {
                      const label = k === "sslCa" ? "CA 证书文件" : k === "sslCert" ? "客户端证书" : "客户端私钥";
                      const value = k === "sslCa" ? sslCa : k === "sslCert" ? sslCert : sslKey;
                      const setter = k === "sslCa" ? setSslCa : k === "sslCert" ? setSslCert : setSslKey;
                      return (
                        <div key={k} className="grid gap-1.5">
                          <Label>{label}（可选）</Label>
                          <div className="flex gap-2">
                            <Input value={value} onChange={(e) => setter(e.target.value)} className="font-mono" />
                            <Button type="button" variant="outline" size="sm" onClick={() => void pickFile(setter)}>
                              浏览
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  )}

                  <div className="col-span-2 grid gap-2 rounded-md border p-3">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <Checkbox
                        checked={sshEnabled}
                        onCheckedChange={(v) => setSshEnabled(v === true)}
                      />
                      通过 SSH 隧道连接（跳板机）
                    </label>
                    {sshEnabled && (
                      <>
                        <div className="grid grid-cols-3 gap-3">
                          <div className="grid gap-1.5">
                            <Label>跳板机主机</Label>
                            <Input value={sshHost} onChange={(e) => setSshHost(e.target.value)} className="font-mono" />
                          </div>
                          <div className="grid gap-1.5">
                            <Label>端口</Label>
                            <Input value={sshPort} onChange={(e) => setSshPort(e.target.value)} className="font-mono" />
                          </div>
                          <div className="grid gap-1.5">
                            <Label>用户名</Label>
                            <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="root" />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="grid gap-1.5">
                            <Label>认证方式</Label>
                            <Select value={sshAuthMethod} onValueChange={setSshAuthMethod}>
                              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="private_key">私钥</SelectItem>
                                <SelectItem value="password">密码</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {sshAuthMethod === "password" ? (
                            <div className="grid gap-1.5">
                              <Label>跳板机密码 / 私钥口令</Label>
                              <Input
                                type="password"
                                value={sshPassword}
                                onChange={(e) => setSshPassword(e.target.value)}
                                placeholder={isNew ? "" : "留空则不改"}
                                autoComplete="new-password"
                              />
                            </div>
                          ) : (
                            <div className="grid gap-1.5">
                              <Label>私钥文件</Label>
                              <div className="flex gap-2">
                                <Input
                                  value={sshPrivateKeyPath}
                                  onChange={(e) => setSshPrivateKeyPath(e.target.value)}
                                  className="font-mono"
                                />
                                <Button type="button" variant="outline" size="sm" onClick={() => void pickFile(setSshPrivateKeyPath)}>
                                  浏览
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}

        </div>

        {testResult && (
          <div className={`flex shrink-0 items-center gap-1.5 text-sm ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>
            {testResult.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            {testResult.msg}
          </div>
        )}

        <div className="flex shrink-0 justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void save()}>保存</Button>
          <Button variant="outline" disabled={testing} onClick={() => void test()}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : null}
            测试连接
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
