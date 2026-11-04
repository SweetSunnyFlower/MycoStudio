export type Theme = "light" | "dark" | "system";

const KEY = "dbdesktop.theme";

export function loadTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
}

export function resolvedTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

let transitionTimer: number | undefined;

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // 切换瞬间短暂打开全局颜色过渡，让主题变化是渐变而不是硬切
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce) {
    root.classList.add("theme-transition");
    window.clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(() => root.classList.remove("theme-transition"), 300);
  }
  root.classList.toggle("dark", resolvedTheme(theme) === "dark");
}

/** 跟随系统模式下，系统主题变化时回调 */
export function onSystemThemeChange(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => cb();
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}
