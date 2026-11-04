import { create } from "zustand";
import { toast } from "sonner";
import type { BrowsedTable, ConnectionConfig, ResultSet } from "@/lib/types";
import { applyTheme, loadTheme, onSystemThemeChange, saveTheme, type Theme } from "@/lib/theme";

export type AppView = "splash" | "connections" | "workspace" | "settings" | "pdm";
export type ConnStatus = "untested" | "testing" | "ok" | "error";
export interface BrowseKey { db: string; table: string; }

interface AppState {
  view: AppView;
  connections: ConnectionConfig[];
  search: string;
  statuses: Record<string, ConnStatus>;
  activeId: string | null;
  databases: string[];
  browseKey: BrowseKey | null;
  result: ResultSet | BrowsedTable | null;
  loading: boolean;
  error: string | null;
  theme: Theme;
  setView: (v: AppView) => void;
  setConnections: (c: ConnectionConfig[]) => void;
  setSearch: (s: string) => void;
  setStatus: (id: string, s: ConnStatus) => void;
  setActiveId: (id: string | null) => void;
  setDatabases: (d: string[]) => void;
  setBrowseKey: (k: BrowseKey | null) => void;
  setResult: (r: ResultSet | BrowsedTable | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setTheme: (t: Theme) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "splash",
  connections: [],
  search: "",
  statuses: {},
  activeId: null,
  databases: [],
  browseKey: null,
  result: null,
  loading: false,
  error: null,
  theme: loadTheme(),
  setView: (view) => set({ view }),
  setConnections: (connections) => set({ connections }),
  setSearch: (search) => set({ search }),
  setStatus: (id, s) => set((st) => ({ statuses: { ...st.statuses, [id]: s } })),
  setActiveId: (activeId) => set({ activeId }),
  setDatabases: (databases) => set({ databases }),
  setBrowseKey: (browseKey) => set({ browseKey }),
  setResult: (result) => set({ result }),
  setLoading: (loading) => set({ loading }),
  // 全局错误统一走 toast，不再在页面底部渲染一条把内容挤矮的错误条
  setError: (error) => {
    if (error) toast.error(error, { duration: 8000 });
    set({ error });
  },
  setTheme: (theme) => {
    saveTheme(theme);
    applyTheme(theme);
    set({ theme });
  },
}));

// 应用启动时应用一次主题，并跟随系统变化
applyTheme(useAppStore.getState().theme);
onSystemThemeChange(() => {
  if (useAppStore.getState().theme === "system") {
    applyTheme("system");
  }
});
