import type { AppConfig, PromptSourceConfig } from "@/types/board";
import { normalizeObjectStorage } from "@/lib/object-storage";
import { normalizePromptSourceConfigs } from "@/services/prompt-sources";
import {
  clonePresetSource,
  COMMUNITY_PROMPT_SOURCE_PRESETS,
} from "@/services/prompt-source-presets";
import { normalizeImageToolbarPreferences } from "@/lib/image-toolbar-preferences";
import { normalizeGenerationDefaults } from "@/lib/generation-defaults";

export const SYSTEM_PROMPT_MAX_LENGTH = 20_000;

export function applySystemPrompt(systemPrompt: string, prompt: string): string {
  const system = systemPrompt.trim();
  return system ? `${system}

${prompt}` : prompt;
}

/** Always surface Image Prompts registry built-ins; preserve user enablement/status. */
export function mergeBuiltinPromptSources(
  sources: readonly PromptSourceConfig[],
): PromptSourceConfig[] {
  const builtins = COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => clonePresetSource(preset));
  const byId = new Map(sources.map((source) => [source.id, source]));
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  const mergedBuiltins = builtins.map((builtin) => {
    const saved = byId.get(builtin.id) ?? byUrl.get(builtin.url);
    if (!saved) return builtin;
    return {
      ...builtin,
      enabled: saved.enabled,
      refreshMinutes: saved.refreshMinutes,
      lastFetchedAt: saved.lastFetchedAt,
      lastSuccessAt: saved.lastSuccessAt,
      lastError: saved.lastError,
      itemCount: saved.itemCount,
    };
  });
  const builtinIds = new Set(builtins.map((source) => source.id));
  const builtinUrls = new Set(builtins.map((source) => source.url));
  const custom = sources.filter((source) =>
    !source.builtIn && !builtinIds.has(source.id) && !builtinUrls.has(source.url));
  return [...mergedBuiltins, ...custom];
}

export function normalizeAppConfig(config: AppConfig): AppConfig {
  const rawSystemPrompt = (config as AppConfig & { systemPrompt?: unknown }).systemPrompt;
  const rawPanelWidth = (config as AppConfig & { canvasPanelWidth?: unknown }).canvasPanelWidth;
  const rawPanelTab = (config as AppConfig & { canvasPanelTab?: unknown }).canvasPanelTab;
  const rawDisabled = (config as AppConfig & { disabledPluginIds?: unknown }).disabledPluginIds;
	const rawSharedChannelID = (config as AppConfig & { activeSharedChannelId?: unknown }).activeSharedChannelId;
  const disabledPluginIds = Array.isArray(rawDisabled)
    ? [...new Set(rawDisabled.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  return {
    ...config,
		activeSharedChannelId: typeof rawSharedChannelID === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(rawSharedChannelID)
			? rawSharedChannelID : null,
    systemPrompt: typeof rawSystemPrompt === "string"
      ? rawSystemPrompt.slice(0, SYSTEM_PROMPT_MAX_LENGTH)
      : "",
    canvasPanelWidth: typeof rawPanelWidth === "number" && Number.isFinite(rawPanelWidth)
      ? Math.min(420, Math.max(240, Math.round(rawPanelWidth)))
      : 256,
    canvasPanelCollapsed: config.canvasPanelCollapsed === true,
    canvasPanelTab: rawPanelTab === "elements" || rawPanelTab === "assets" || rawPanelTab === "prompts"
      ? rawPanelTab
      : "projects",
    disabledPluginIds,
    objectStorage: normalizeObjectStorage((config as AppConfig & { objectStorage?: unknown }).objectStorage),
    promptSources: mergeBuiltinPromptSources(normalizePromptSourceConfigs(
      (config as AppConfig & { promptSources?: unknown }).promptSources)),
    imageToolbar: normalizeImageToolbarPreferences(
      (config as AppConfig & { imageToolbar?: unknown }).imageToolbar),
    generationDefaults: normalizeGenerationDefaults(
      (config as AppConfig & { generationDefaults?: unknown }).generationDefaults),
    workflowAgentSystemPrompt: typeof (config as AppConfig & { workflowAgentSystemPrompt?: unknown }).workflowAgentSystemPrompt === "string"
      ? ((config as AppConfig & { workflowAgentSystemPrompt?: string }).workflowAgentSystemPrompt ?? "").slice(0, SYSTEM_PROMPT_MAX_LENGTH)
      : "",
  };
}
