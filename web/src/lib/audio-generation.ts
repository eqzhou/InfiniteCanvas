import { DEFAULT_GENERATION_DEFAULTS, type GenerationDefaults } from "@/lib/generation-defaults";

/**
 * Resolves audio generation settings for a node. The node value wins; the
 * tenant defaults fill the rest. Optional fields stay omitted when unset so the
 * provider default applies rather than a value we invented.
 */
export function audioSpeechOptions(
  nodeVoice: string | undefined,
  defaults: GenerationDefaults | undefined,
): { voice: string; format: string; speed?: number; instructions?: string } {
  const resolved = defaults ?? DEFAULT_GENERATION_DEFAULTS;
  const instructions = resolved.audioInstructions.trim();
  return {
    voice: nodeVoice?.trim() || resolved.audioVoice,
    format: resolved.audioFormat,
    ...(resolved.audioSpeed > 0 ? { speed: resolved.audioSpeed } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

/** Same resolution for durable server jobs, which use a fixed parameter shape. */
export function audioJobParameters(
  nodeVoice: string | undefined,
  defaults: GenerationDefaults | undefined,
): { voice: string; format: string; speed?: number; instructions?: string } {
  return audioSpeechOptions(nodeVoice, defaults);
}
