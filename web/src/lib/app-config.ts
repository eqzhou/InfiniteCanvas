import type { AppConfig } from "@/types/board";
import { normalizePromptSourceConfigs } from "@/services/prompt-sources";

export const SYSTEM_PROMPT_MAX_LENGTH = 20_000;

export function applySystemPrompt(systemPrompt: string, prompt: string): string {
  const system = systemPrompt.trim();
  return system ? `${system}\n\n${prompt}` : prompt;
}

export function normalizeAppConfig(config: AppConfig): AppConfig {
  const rawSystemPrompt = (config as AppConfig & { systemPrompt?: unknown }).systemPrompt;
  const rawPanelWidth = (config as AppConfig & { canvasPanelWidth?: unknown }).canvasPanelWidth;
  const rawPanelTab = (config as AppConfig & { canvasPanelTab?: unknown }).canvasPanelTab;
  return {
    ...config,
    systemPrompt: typeof rawSystemPrompt === "string"
      ? rawSystemPrompt.slice(0, SYSTEM_PROMPT_MAX_LENGTH)
      : "",
    canvasPanelWidth: typeof rawPanelWidth === "number" && Number.isFinite(rawPanelWidth)
      ? Math.min(420, Math.max(220, Math.round(rawPanelWidth)))
      : 256,
    canvasPanelCollapsed: config.canvasPanelCollapsed === true,
    canvasPanelTab: rawPanelTab === "elements" || rawPanelTab === "assets"
      ? rawPanelTab
      : "projects",
    promptSources: normalizePromptSourceConfigs(
      (config as AppConfig & { promptSources?: unknown }).promptSources),
  };
}
