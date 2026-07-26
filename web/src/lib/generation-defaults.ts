/**
 * Tenant-independent generation defaults that new nodes and workbench sessions
 * inherit. Node-level values always win; these only seed them.
 */
export type GenerationDefaults = {
  videoRatio: string;
  videoResolution: string;
  videoSeconds: number;
  videoGenerateAudio: boolean;
  videoWatermark: boolean;
  audioVoice: string;
  audioFormat: string;
  /** 0 means unset, so the provider default applies. */
  audioSpeed: number;
  audioInstructions: string;
};

export const AUDIO_FORMATS = ["mp3", "wav", "opus", "aac", "flac", "pcm"] as const;

/** Kept in sync with the video document validator in `board-document.ts`. */
export const VIDEO_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;

export const DEFAULT_GENERATION_DEFAULTS: Readonly<GenerationDefaults> = Object.freeze({
  videoRatio: "16:9",
  videoResolution: "720p",
  videoSeconds: 5,
  videoGenerateAudio: false,
  videoWatermark: false,
  audioVoice: "alloy",
  audioFormat: "mp3",
  audioSpeed: 0,
  audioInstructions: "",
});

const MAX_TOKEN_LENGTH = 64;
const MAX_INSTRUCTIONS_LENGTH = 2_000;

function pick(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

export function normalizeGenerationDefaults(value: unknown): GenerationDefaults {
  const candidate = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const seconds = candidate.videoSeconds;
  const speed = candidate.audioSpeed;
  const voice = candidate.audioVoice;
  const instructions = candidate.audioInstructions;
  return {
    videoRatio: pick(candidate.videoRatio, VIDEO_RATIOS, DEFAULT_GENERATION_DEFAULTS.videoRatio),
    videoResolution: pick(candidate.videoResolution, VIDEO_RESOLUTIONS, DEFAULT_GENERATION_DEFAULTS.videoResolution),
    videoSeconds: typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 4 && seconds <= 15
      ? seconds
      : DEFAULT_GENERATION_DEFAULTS.videoSeconds,
    videoGenerateAudio: candidate.videoGenerateAudio === true,
    videoWatermark: candidate.videoWatermark === true,
    audioVoice: typeof voice === "string" && voice.trim().length > 0 && voice.trim().length <= MAX_TOKEN_LENGTH
      ? voice.trim()
      : DEFAULT_GENERATION_DEFAULTS.audioVoice,
    audioFormat: pick(candidate.audioFormat, AUDIO_FORMATS, DEFAULT_GENERATION_DEFAULTS.audioFormat),
    audioSpeed: typeof speed === "number" && Number.isFinite(speed) && speed >= 0.25 && speed <= 4
      ? speed
      : DEFAULT_GENERATION_DEFAULTS.audioSpeed,
    audioInstructions: typeof instructions === "string"
      ? instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH)
      : DEFAULT_GENERATION_DEFAULTS.audioInstructions,
  };
}
