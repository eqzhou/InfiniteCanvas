import type { AiProtocol, AudioRolePreset } from "@/types/board";

const AUDIO_SERVER_PROTOCOLS = new Set<AiProtocol>(["openai", "azure", "edge"]);
const AUDIO_ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AUDIO_ROLE_PROTOCOLS: readonly AiProtocol[] = ["openai", "azure", "edge"];

export const AUDIO_PROTOCOL_OPTIONS: ReadonlyArray<{ value: AiProtocol; label: string }> = [
  { value: "openai", label: "OpenAI Compatible" },
  { value: "azure", label: "Azure Speech" },
  { value: "edge", label: "Edge TTS（实验）" },
];

export const AZURE_EDGE_CHINESE_VOICES = [
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunxiaNeural",
  "zh-CN-YunyangNeural",
  "zh-CN-liaoning-XiaobeiNeural",
  "zh-CN-shaanxi-XiaoniNeural",
] as const;

export const OPENAI_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
] as const;

const AUDIO_VOICE_LABELS: Readonly<Record<string, string>> = {
  "zh-CN-XiaoxiaoNeural": "晓晓（女声）",
  "zh-CN-XiaoyiNeural": "晓伊（女声）",
  "zh-CN-YunjianNeural": "云健（男声）",
  "zh-CN-YunxiNeural": "云希（男声）",
  "zh-CN-YunxiaNeural": "云夏（男声）",
  "zh-CN-YunyangNeural": "云扬（男声）",
  "zh-CN-liaoning-XiaobeiNeural": "晓北（女声·东北）",
  "zh-CN-shaanxi-XiaoniNeural": "晓妮（女声·陕西）",
  alloy: "合金（中性）",
  ash: "阿什（偏男声）",
  ballad: "叙事（偏男声）",
  coral: "珊瑚（偏女声）",
  echo: "回声（偏男声）",
  fable: "寓言（偏男声）",
  nova: "新星（偏女声）",
  onyx: "黑曜（偏男声）",
  sage: "鼠尾草（偏女声）",
  shimmer: "微光（偏女声）",
  verse: "诗韵（偏男声）",
};

export function audioVoiceOptions(protocol: AiProtocol): readonly string[] {
  return protocol === "azure" || protocol === "edge" ? AZURE_EDGE_CHINESE_VOICES : OPENAI_VOICES;
}

/** User-facing label only; provider requests continue to use the stable ID. */
export function audioVoiceLabel(voice: string): string {
  return AUDIO_VOICE_LABELS[voice] ?? voice;
}

export function defaultAudioVoice(protocol: AiProtocol): string {
  return protocol === "azure" || protocol === "edge" ? "zh-CN-XiaoxiaoNeural" : "alloy";
}

export function audioFormatOptions(protocol: AiProtocol): readonly string[] {
  if (protocol === "edge") return ["mp3"];
  if (protocol === "azure") return ["mp3", "wav", "opus", "pcm"];
  return ["mp3", "wav", "opus", "aac", "flac", "pcm"];
}

export function audioProviderPreset(protocol: AiProtocol): { baseUrl: string; model: string; apiKey?: string } {
  if (protocol === "azure") {
    return { baseUrl: "https://<region>.tts.speech.microsoft.com", model: "azure-neural-tts" };
  }
  if (protocol === "edge") {
    return {
      baseUrl: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud",
      model: "edge-tts",
      apiKey: "",
    };
  }
  return { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts" };
}

export function audioProtocolSupportsServerJobs(protocol: AiProtocol): boolean {
  return AUDIO_SERVER_PROTOCOLS.has(protocol);
}

export function audioProtocolRequiresKey(protocol: AiProtocol): boolean {
  return protocol !== "edge";
}

export function audioRoleDefaultLabel(roles: readonly AudioRolePreset[] | undefined): string {
  return roles?.length ? "无角色（使用默认声音）" : "未配置角色（请在项目中添加）";
}

export function normalizeAudioRoles(value: unknown): AudioRolePreset[] {
  if (!Array.isArray(value)) return [];
  const result: AudioRolePreset[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 32)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 80) : "";
    if (!AUDIO_ROLE_ID.test(id) || !name || seen.has(id)) continue;
    const rawVoices = candidate.voices && typeof candidate.voices === "object" && !Array.isArray(candidate.voices)
      ? candidate.voices as Record<string, unknown>
      : {};
    const voices: AudioRolePreset["voices"] = {};
    for (const protocol of AUDIO_ROLE_PROTOCOLS) {
      const voice = rawVoices[protocol];
      if (typeof voice === "string" && voice.trim() && voice.trim().length <= 100) {
        voices[protocol] = voice.trim();
      }
    }
    seen.add(id);
    result.push({ id, name, voices });
  }
  return result;
}

export function resolveAudioVoice({
  roles,
  roleId,
  protocol,
  fallback,
  explicit,
}: {
  roles: readonly AudioRolePreset[] | undefined;
  roleId: string | undefined;
  protocol: AiProtocol;
  fallback: string;
  explicit?: string;
}): string {
  const compatible = (voice: string | undefined): string => {
    const normalized = voice?.trim() ?? "";
    if (!normalized) return "";
    const knownOpenAI = (OPENAI_VOICES as readonly string[]).includes(normalized);
    const knownAzureEdge = (AZURE_EDGE_CHINESE_VOICES as readonly string[]).includes(normalized);
    if (protocol === "openai" && knownAzureEdge) return "";
    if ((protocol === "azure" || protocol === "edge") && knownOpenAI) return "";
    return normalized;
  };
  const direct = compatible(explicit);
  if (direct) return direct;
  const role = roles?.find((item) => item.id === roleId);
  return compatible(role?.voices[protocol]) || compatible(fallback) || defaultAudioVoice(protocol);
}
