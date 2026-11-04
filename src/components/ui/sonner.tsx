"use client"

import type { CSSProperties } from "react"
import { Toaster as SonnerToaster, type ToasterProps } from "sonner"
import { resolvedTheme } from "@/lib/theme"
import { useAppStore } from "@/store/app"

/**
 * 全局 toast：临时提示走这里，不要插在页面里把布局挤动。
 *
 * 配色是反色的单色：浅色主题下黑底白字，深色主题下白底黑字。
 * 直接借用主题的 foreground/background 两个变量，就能自动跟着主题对调。
 */
function Toaster(props: ToasterProps) {
  const theme = useAppStore((s) => s.theme)
  const monoVars = {
    "--normal-bg": "var(--foreground)",
    "--normal-text": "var(--background)",
    "--normal-border": "var(--foreground)",
  } as CSSProperties

  return (
    <SonnerToaster
      position="bottom-right"
      closeButton
      theme={resolvedTheme(theme)}
      style={monoVars}
      toastOptions={{
        classNames: {
          toast: "text-sm shadow-lg",
          // sonner 默认把说明文字写死成灰色，这里让它跟随 toast 自身的文字色
          description: "!text-current opacity-80",
          // 关闭按钮保持 sonner 默认的实心底色（黑底白 ✕ / 深色下反过来），
          // 只覆盖 hover：反色成「背景色底 + 前景色 ✕」，避免默认浅灰底上看不见 ✕
          closeButton: "hover:!border-background hover:!bg-background hover:!text-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
