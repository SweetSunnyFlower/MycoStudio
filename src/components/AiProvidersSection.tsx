import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MoreVertical,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TypeCombobox } from "@/components/TypeCombobox";
import { api } from "@/lib/api";
import { loadAiProviders, primeAiProviders } from "@/lib/aiProviders";
import { cn } from "@/lib/utils";
import type { AiProvider, AiProviders, AiTestResult } from "@/lib/types";

function emptyProvider(): AiProvider {
  return {
    id: crypto.randomUUID(),
    name: "",
    base_url: "",
    token: "",
    default_model: "",
    models: [],
  };
}

export function AiProvidersSection() {
  const [data, setData] = useState<AiProviders | null>(null);
  const [draft, setDraft] = useState<AiProvider | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AiProvider | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 走带缓存的读取：AI 抽屉也能同步拿到同一份数据
    loadAiProviders(true)
      .then(setData)
      .catch((e) => toast.error("读取供应商失败", { description: String(e) }));
  }, []);

  async function makeDefault(p: AiProvider) {
    if (!data || data.default_id === p.id) return;
    try {
      const next = await api.setDefaultAiProvider(p.id);
      setData(next);
      primeAiProviders(next);
      toast.success(`已设为默认供应商：${p.name}`);
    } catch (e) {
      toast.error("设置失败", { description: String(e) });
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      const next = await api.deleteAiProvider(pendingDelete.id);
      setData(next);
      primeAiProviders(next);
      toast.success(`已删除供应商：${pendingDelete.name}`);
      setPendingDelete(null);
    } catch (e) {
      toast.error("删除失败", { description: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (draft) {
    return (
      <ProviderForm
        initial={draft}
        isNew={!data?.providers.some((p) => p.id === draft.id)}
        onCancel={() => setDraft(null)}
        onSaved={async (saved) => {
          setData(saved);
          setDraft(null);
        }}
      />
    );
  }

  const providers = data?.providers ?? [];

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">供应商</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理 AI 模型服务商。点卡片设为默认，⋯ 里可以编辑或删除。
          </p>
        </div>
        <Button size="sm" onClick={() => setDraft(emptyProvider())}>
          <Plus className="size-4" /> 添加供应商
        </Button>
      </div>

      {providers.length === 0 ? (
        <p className="mt-16 text-center text-sm text-muted-foreground">
          还没有供应商，点右上角「添加供应商」开始
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => {
            const isDefault = data?.default_id === p.id;
            const hasToken = p.token.trim().length > 0;
            return (
              <div
                key={p.id}
                className={cn(
                  "flex flex-col rounded-xl border bg-card transition hover:border-ring/60 hover:shadow-sm",
                  isDefault && "border-primary/60 ring-1 ring-primary/30",
                )}
              >
                <div className="flex items-start gap-2 p-4 pb-3">
                  {/* 卡片主体用真正的 button（键盘可达）；⋯ 必须是它的兄弟节点，
                      再嵌一层 button 的话无障碍树会把 ⋯ 合并掉，键盘和读屏都点不到 */}
                  <button
                    type="button"
                    title="设为默认供应商"
                    onClick={() => void makeDefault(p)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{p.name || "未命名供应商"}</span>
                      {isDefault && (
                        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          默认
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                      {p.default_model || "未设置默认模型"}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" title="更多">
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setDraft({ ...p })}>
                        <Pencil className="size-4" /> 编辑
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete(p)}>
                        <Trash2 className="size-4" /> 删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="h-px bg-border" />
                <button
                  type="button"
                  title="设为默认供应商"
                  onClick={() => void makeDefault(p)}
                  className="flex w-full items-center justify-between gap-2 p-3 text-xs"
                >
                  <span
                    className={cn(
                      "flex items-center gap-1.5",
                      isDefault ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {isDefault ? (
                      <>
                        <Check className="size-3.5" /> 默认
                      </>
                    ) : (
                      "设为默认"
                    )}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5",
                      hasToken ? "text-emerald-600" : "text-amber-600",
                    )}
                  >
                    {hasToken ? (
                      <>
                        <KeyRound className="size-3.5" /> 已配置 Token
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="size-3.5" /> 未配置 Token
                      </>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除供应商</DialogTitle>
            <DialogDescription>
              确定删除「{pendingDelete?.name}」？该供应商的地址与 Token 会一并从本地移除，不可撤销。
              {data?.default_id === pendingDelete?.id &&
                " 这是当前的默认供应商，删除后默认会切到列表里的第一个。"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProviderForm({
  initial,
  isNew,
  onCancel,
  onSaved,
}: {
  initial: AiProvider;
  isNew: boolean;
  onCancel: () => void;
  onSaved: (data: AiProviders) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [baseUrl, setBaseUrl] = useState(initial.base_url);
  const [token, setToken] = useState(initial.token);
  const [defaultModel, setDefaultModel] = useState(initial.default_model);
  const [models, setModels] = useState<string[]>(initial.models);
  const [showToken, setShowToken] = useState(false);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canProbe = baseUrl.trim().length > 0 && token.trim().length > 0;
  const canSave = name.trim().length > 0 && baseUrl.trim().length > 0 && token.trim().length > 0;

  // 名称/地址/Token 一改，上一次的测试结论就失效了——
  // 否则会出现「已经改好了，红色错误还挂在下面」的错觉
  useEffect(() => {
    setTest(null);
  }, [name, baseUrl, token]);

  function current(): AiProvider {
    return {
      id: initial.id,
      name: name.trim(),
      base_url: baseUrl.trim(),
      token: token.trim(),
      default_model: defaultModel.trim(),
      models,
    };
  }

  /** 在默认模型框里回车：没有就加进模型列表，并设为默认 */
  function commitModel(raw: string) {
    const value = raw.trim();
    if (!value) return;
    if (!models.includes(value)) {
      setModels((prev) => [...prev, value]);
      toast.success(`已添加模型 ${value}`);
    }
    setDefaultModel(value);
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testAiProvider(current());
      if (r.ok) {
        // 成功就地显示（带模型数量，信息有用），失败走 toast——
        // 失败信息常常是一大段服务端返回，糊在表单里又长又吓人
        setTest(r);
        setModels(r.models);
        if (!defaultModel.trim() && r.models[0]) setDefaultModel(r.models[0]);
      } else {
        toast.error("Token 无效", { description: r.message, duration: 10000 });
      }
    } catch (e) {
      toast.error("测试失败", { description: String(e), duration: 10000 });
    } finally {
      setTesting(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    setError(null);
    try {
      const merged = await api.syncAiModels(current());
      const added = merged.length - models.length;
      setModels(merged);
      // 同步能成功说明凭据没问题，把之前可能挂着的失败结论清掉
      setTest(null);
      if (!defaultModel.trim() && merged[0]) setDefaultModel(merged[0]);
      toast.success(added > 0 ? `已同步，新增 ${added} 个模型` : "已同步，没有新模型");
    } catch (e) {
      toast.error("同步模型失败", { description: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveAiProvider(current());
      primeAiProviders(next);
      onSaved(next);
      toast.success(isNew ? "已添加供应商" : "已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="size-8" title="返回" onClick={onCancel}>
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isNew ? "添加供应商" : "编辑供应商"}
        </h1>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">基本信息</h2>
        <div className="mt-2 grid gap-4 rounded-xl border p-4">
          <div className="grid gap-1.5">
            <Label>名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 DeepSeek"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>地址</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com"
              className="font-mono"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>API Token</Label>
              <Button
                size="xs"
                variant="outline"
                disabled={!canProbe || testing}
                onClick={() => void runTest()}
              >
                {testing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <PlugZap className="size-3.5" />
                )}
                测试
              </Button>
            </div>
            <div className="relative">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="sk-…"
                className="pr-9 font-mono"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                title={showToken ? "隐藏" : "显示"}
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {test && (
              <div
                className={cn(
                  "flex items-start gap-1.5 text-xs wrap-anywhere",
                  test.ok ? "text-emerald-600" : "text-red-600",
                )}
              >
                <div className="flex flex-row justify-start gap-2 items-center">
                  {test.ok ? (
                    <CheckCircle2 className="size-3.5 shrink-0" />
                  ) : (
                    <XCircle className="size-3.5 shrink-0" />
                  )}
                  <span>{test.message}</span>
                </div>

              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">模型</h2>
          <Button
            size="xs"
            variant="outline"
            disabled={!canProbe || syncing}
            onClick={() => void runSync()}
          >
            {syncing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            同步模型
          </Button>
        </div>
        <div className="mt-2 grid gap-4 rounded-xl border p-4">
          <div className="grid gap-1.5">
            <Label>默认模型</Label>
            <TypeCombobox
              value={defaultModel}
              onChange={setDefaultModel}
              options={models}
              onCommit={commitModel}
              placeholder="选择或直接输入模型名，回车即添加为默认"
            />
            <p className="text-xs text-muted-foreground">
              候选来自「同步模型」，也可以直接输入；共 {models.length} 个模型
            </p>
          </div>
        </div>
      </section>

      {error && <div className="mt-4 text-xs text-destructive [overflow-wrap:anywhere]">{error}</div>}

      <div className="mt-6 flex justify-end gap-2 pb-4">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} 保存
        </Button>
      </div>
    </>
  );
}
