import { useEffect } from "react";
import { shouldAutoloadLazySlice } from "@/lib/lazy-workspace";
import { useBoardStore } from "@/stores/use-board-store";

export function useLazyProjects() {
  const ready = useBoardStore((state) => state.ready);
  const projectsState = useBoardStore((state) => state.projectsState);
  const projectsError = useBoardStore((state) => state.projectsError);
  const loadProjectsOnDemand = useBoardStore((state) => state.loadProjectsOnDemand);

  useEffect(() => {
    if (!shouldAutoloadLazySlice(ready, projectsState)) return;
    void loadProjectsOnDemand().catch(() => undefined);
  }, [loadProjectsOnDemand, projectsState, ready]);

  return { ready, projectsState, projectsError, loadProjectsOnDemand };
}

export function useLazyAssets() {
  const ready = useBoardStore((state) => state.ready);
  const assetsState = useBoardStore((state) => state.assetsState);
  const assetsError = useBoardStore((state) => state.assetsError);
  const loadAssetsOnDemand = useBoardStore((state) => state.loadAssetsOnDemand);

  useEffect(() => {
    if (!shouldAutoloadLazySlice(ready, assetsState)) return;
    void loadAssetsOnDemand().catch(() => undefined);
  }, [assetsState, loadAssetsOnDemand, ready]);

  return { ready, assetsState, assetsError, loadAssetsOnDemand };
}

export function useLazyPrompts() {
  const ready = useBoardStore((state) => state.ready);
  const promptsState = useBoardStore((state) => state.promptsState);
  const promptsError = useBoardStore((state) => state.promptsError);
  const loadPromptsOnDemand = useBoardStore((state) => state.loadPromptsOnDemand);

  useEffect(() => {
    if (!shouldAutoloadLazySlice(ready, promptsState)) return;
    void loadPromptsOnDemand().catch(() => undefined);
  }, [loadPromptsOnDemand, promptsState, ready]);

  return { ready, promptsState, promptsError, loadPromptsOnDemand };
}
