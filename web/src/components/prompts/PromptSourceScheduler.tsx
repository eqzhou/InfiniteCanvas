import { useEffect } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { refreshDuePromptSources } from "@/services/prompt-source-scheduler";

export function PromptSourceScheduler() {
  const ready = useBoardStore((state) => state.ready);

  useEffect(() => {
    if (!ready) return;
    const isActive = () => document.visibilityState === "visible" && document.hasFocus();
    const refresh = () => {
      if (isActive()) void refreshDuePromptSources(Date.now(), { isActive });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [ready]);

  return null;
}
