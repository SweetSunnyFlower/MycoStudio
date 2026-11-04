import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app";
import type { Theme } from "@/lib/theme";
import { AiProvidersSection } from "./AiProvidersSection";

type SectionId = "general" | "appearance" | "providers";

const NAV: { group: string; items: { id: SectionId; label: string }[] }[] = [
  {
    group: "个人",
    items: [
      { id: "general", label: "常规" },
      { id: "appearance", label: "外观" },
    ],
  },
  {
    group: "AI",
    items: [{ id: "providers", label: "供应商" }],
  },
];

export function SettingsPage() {
  const setView = useAppStore((s) => s.setView);
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  const reduce = useReducedMotion() ?? false;

  const needle = query.trim().toLowerCase();
  const groups = NAV.map((g) => ({
    ...g,
    items: needle ? g.items.filter((i) => i.label.toLowerCase().includes(needle)) : g.items,
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r">
        <div className="px-4 pt-4">
          <div className="flex items-center justify-between">
            <span className="text-lg font-semibold tracking-tight">设置</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="返回连接管理"
              onClick={() => setView("connections")}
            >
              <ArrowLeft className="size-4" />
            </Button>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索"
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
        <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-4">
          {groups.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">无匹配设置</p>
          ) : (
            groups.map((g) => (
              <div key={g.group} className="mb-2">
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{g.group}</div>
                {g.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSection(item.id)}
                    className={cn(
                      "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm",
                      section === item.id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))
          )}
        </nav>
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-10 py-10">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4, transition: { duration: 0.08 } }}
              transition={{ duration: reduce ? 0 : 0.15, ease: "easeOut" }}
            >
              {section === "providers" ? (
                <AiProvidersSection />
              ) : section === "appearance" ? (
                <AppearanceSection />
              ) : (
                <GeneralSection />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function SectionTitle({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="mt-2 rounded-xl border">{children}</div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
      <span className="text-sm">{label}</span>
      <span className={cn("truncate text-sm text-muted-foreground", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function GeneralSection() {
  const [info, setInfo] = useState<{ version: string; config_dir: string } | null>(null);

  useEffect(() => {
    void api.appInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">常规</h1>
      <SectionTitle title="应用">
        <Row label="名称" value="蘑菇 Myco Studio" />
        <Row label="版本" value={info?.version ?? "—"} />
        <Row label="配置文件目录" value={info?.config_dir ?? "—"} mono />
      </SectionTitle>
    </>
  );
}

function AppearanceSection() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">外观</h1>
      <SectionTitle title="视觉风格">
        <div className="flex items-center justify-between gap-6 px-4 py-4">
          <span className="shrink-0 text-sm">模式</span>
          <div className="flex gap-3">
            <ModeCard mode="light" label="浅色" current={theme} onSelect={setTheme} />
            <ModeCard mode="dark" label="深色" current={theme} onSelect={setTheme} />
            <ModeCard mode="system" label="跟随系统" current={theme} onSelect={setTheme} />
          </div>
        </div>
      </SectionTitle>
      <SectionTitle title="界面">
        <Row label="字体" value="系统默认（Geist）" />
      </SectionTitle>
    </>
  );
}

function ModeCard({
  mode,
  label,
  current,
  onSelect,
}: {
  mode: Theme;
  label: string;
  current: Theme;
  onSelect: (t: Theme) => void;
}) {
  const active = current === mode;
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      title={label}
      className={cn(
        "rounded-lg border-2 p-0.5 transition-colors",
        active ? "border-primary" : "border-transparent hover:border-muted-foreground/30",
      )}
    >
      <ModePreview mode={mode} />
    </button>
  );
}

function ModePreview({ mode }: { mode: Theme }) {
  const bars = (bg: string, line: string) => (
    <div className={cn("flex h-full w-full flex-col gap-1 p-1.5", bg)}>
      <div className={cn("h-1.5 w-8 rounded-sm", line)} />
      <div className={cn("h-1 w-12 rounded-sm", line)} />
      <div className={cn("h-1 w-10 rounded-sm", line)} />
      <div className="mt-auto h-1.5 w-4 rounded-sm bg-primary" />
    </div>
  );

  return (
    <div className="h-14 w-24 overflow-hidden rounded-md border">
      {mode === "light" && bars("bg-white", "bg-zinc-300")}
      {mode === "dark" && bars("bg-zinc-900", "bg-zinc-600")}
      {mode === "system" && (
        <div className="relative h-full w-full">
          <div className="absolute inset-0">{bars("bg-white", "bg-zinc-300")}</div>
          <div className="absolute inset-y-0 right-0 w-1/2 overflow-hidden">{bars("bg-zinc-900", "bg-zinc-600")}</div>
        </div>
      )}
    </div>
  );
}
