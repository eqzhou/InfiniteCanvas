import type { AppConfig } from "@/types/board";

export const SYSTEM_PROMPT_MAX_LENGTH = 20_000;

export function applySystemPrompt(systemPrompt: string, prompt: string): string {
  const system = systemPrompt.trim();
  return system ? `${system}\n\n${prompt}` : prompt;
}

export function normalizeAppConfig(config: AppConfig): AppConfig {
  const rawSystemPrompt = (config as AppConfig & { systemPrompt?: unknown }).systemPrompt;
  return {
    ...config,
    systemPrompt: typeof rawSystemPrompt === "string"
      ? rawSystemPrompt.slice(0, SYSTEM_PROMPT_MAX_LENGTH)
      : "",
  };
}
