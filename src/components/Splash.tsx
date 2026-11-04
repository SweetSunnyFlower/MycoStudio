import { useEffect } from "react";
import { useAppStore } from "@/store/app";
import { Logo } from "@/components/Logo";

export function Splash() {
  const setView = useAppStore((s) => s.setView);

  useEffect(() => {
    const timer = setTimeout(() => setView("connections"), 1600);
    return () => clearTimeout(timer);
  }, [setView]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-background">
      <Logo className="size-20 animate-in fade-in zoom-in-95 duration-700" />
      <div className="flex flex-col items-center gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">蘑菇 Myco Studio</h1>
        <p className="text-sm text-muted-foreground">数据库客户端</p>
      </div>
    </div>
  );
}
