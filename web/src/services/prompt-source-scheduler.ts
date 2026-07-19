import type { AppConfig, PromptItem, PromptSourceConfig } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { fetchPromptSource, mergePromptSourceItems } from "@/services/prompt-sources";
import { loadConfig, loadPrompts } from "@/services/storage";

const refreshing = new Set<string>();

type SchedulerState = {
  config: AppConfig;
  prompts: PromptItem[];
  setConfig: (config: AppConfig) => void;
  setPrompts: (prompts: PromptItem[]) => void;
};

type SchedulerDependencies = {
  isActive: () => boolean;
  flush: () => Promise<void>;
  loadConfig: () => Promise<AppConfig | null>;
  loadPrompts: () => Promise<PromptItem[]>;
  fetchSource: typeof fetchPromptSource;
  getState: () => SchedulerState;
};

function sameSourceDefinition(left: PromptSourceConfig, right: PromptSourceConfig): boolean {
  return left.name === right.name && left.url === right.url && left.format === right.format && left.enabled === right.enabled &&
    left.refreshMinutes === right.refreshMinutes && left.lastFetchedAt === right.lastFetchedAt &&
    JSON.stringify(left.mapping ?? null) === JSON.stringify(right.mapping ?? null) &&
    JSON.stringify(left.html ?? null) === JSON.stringify(right.html ?? null);
}

function defaultDependencies(): SchedulerDependencies {
  return {
    isActive: () => true,
    flush: async () => {
      const state = useBoardStore.getState();
      await Promise.all([state.flushConfig(), state.flushPrompts()]);
    },
    loadConfig,
    loadPrompts,
    fetchSource: fetchPromptSource,
    getState: () => useBoardStore.getState(),
  };
}

export function duePromptSources(
  sources: readonly PromptSourceConfig[],
  now: number,
): PromptSourceConfig[] {
  return sources.filter((source) => {
    if (!source.enabled || source.refreshMinutes < 5) return false;
    const last = source.lastFetchedAt ? Date.parse(source.lastFetchedAt) : 0;
    return !Number.isFinite(last) || now - last >= source.refreshMinutes * 60_000;
  });
}

export async function refreshDuePromptSources(
  now = Date.now(),
  overrides: Partial<SchedulerDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  if (!dependencies.isActive()) return;
  await dependencies.flush();
  const initialState = dependencies.getState();
  const persistedConfig = await dependencies.loadConfig() ?? initialState.config;
  const sources = duePromptSources(persistedConfig.promptSources ?? [], now)
    .filter((source) => !refreshing.has(source.id));
  for (const source of sources) {
    if (!dependencies.isActive()) break;
    refreshing.add(source.id);
    try {
      const items = await dependencies.fetchSource(source);
      if (!dependencies.isActive()) continue;
      await dependencies.flush();
      const state = dependencies.getState();
      const currentConfig = await dependencies.loadConfig() ?? state.config;
      const current = currentConfig.promptSources?.find((item) => item.id === source.id);
      if (!current?.enabled || !sameSourceDefinition(source, current) || !dependencies.isActive()) continue;
      const currentPrompts = await dependencies.loadPrompts();
      if (!dependencies.isActive()) continue;
      state.setPrompts(mergePromptSourceItems(currentPrompts, items, source.id));
      state.setConfig({
        ...currentConfig,
        promptSources: (currentConfig.promptSources ?? []).map((item) =>
          item.id === source.id ? { ...item, lastFetchedAt: new Date(now).toISOString() } : item),
      });
      await dependencies.flush();
    } catch (cause) {
      window.dispatchEvent(new CustomEvent("openboard:prompt-source-error", {
        detail: {
          sourceId: source.id,
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }));
    } finally {
      refreshing.delete(source.id);
    }
  }
}
