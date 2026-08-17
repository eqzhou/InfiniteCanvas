import { useEffect } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { shouldAutoloadLazySlice } from "@/lib/lazy-workspace";
import { refreshDuePromptSources } from "@/services/prompt-source-scheduler";

export function PromptSourceScheduler() {
  const ready = useBoardStore((state) => state.ready);
  const promptsState = useBoardStore((state) => state.promptsState);
  const loadPromptsOnDemand = useBoardStore((state) => state.loadPromptsOnDemand);
  const hasScheduledSources = useBoardStore((state) =>
    (state.config.promptSources ?? []).some((source) => source.enabled && source.refreshMinutes >= 5));

  useEffect(() => {
    if (!hasScheduledSources || !shouldAutoloadLazySlice(ready, promptsState)) return;
    void loadPromptsOnDemand().catch(() => undefined);
  }, [hasScheduledSources, loadPromptsOnDemand, promptsState, ready]);

  useEffect(() => {
    if (!ready || promptsState !== "loaded") return;
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
  }, [promptsState, ready]);

  return null;
}
