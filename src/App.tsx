import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useAppStore } from "@/store/app";
import { Splash } from "@/components/Splash";
import { ConnectionsPage } from "@/components/ConnectionsPage";
import { Workspace } from "@/components/Workspace";
import { SettingsPage } from "@/components/SettingsPage";
import { PdmPage } from "@/components/PdmPage";
import { Toaster } from "@/components/ui/sonner";

export default function App() {
  const view = useAppStore((s) => s.view);
  const reduce = useReducedMotion() ?? false;

  return (
    <div className="flex h-screen flex-col">
      <div className="min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            className="h-full"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.1 } }}
            transition={{ duration: reduce ? 0 : 0.16, ease: "easeOut" }}
          >
            {view === "splash" && <Splash />}
            {view === "connections" && <ConnectionsPage />}
            {view === "workspace" && <Workspace />}
            {view === "settings" && <SettingsPage />}
            {view === "pdm" && <PdmPage />}
          </motion.div>
        </AnimatePresence>
      </div>
      <Toaster />
    </div>
  );
}
