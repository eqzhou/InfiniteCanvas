import { authFetch } from "@/services/auth-session";

export type MediaKind = "image" | "video" | "audio";
export type MediaGenerationMode = "text_to_image" | "image_to_image" | "text_to_video" | "image_to_video" | "text_to_audio";
export type MediaCapability = {
  channelId: string;
  channelName: string;
  protocol: string;
  model: string;
  kind: MediaKind;
  modes: MediaGenerationMode[];
  sizes: string[];
  ratios: string[];
  resolutions: string[];
  durations: number[];
  maxReferences: number;
};
export type MediaCapabilityCatalog = { version: string; models: MediaCapability[] };

const modes = new Set<MediaGenerationMode>(["text_to_image", "image_to_image", "text_to_video", "image_to_video", "text_to_audio"]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const sizePattern = /^(?:\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|\d{3,4}p|[1248][Kk]|auto|adaptive)$/;
const ratioPattern = /^(?:\d{1,2}:\d{1,2}|auto|adaptive)$/;
const resolutionPattern = /^(?:\d{3,4}p|[1248][Kk]|auto)$/;

function parseCapability(value: unknown): MediaCapability | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<MediaCapability>;
  const kind = item.kind;
  if (!idPattern.test(item.channelId ?? "") || typeof item.channelName !== "string" || !item.channelName.trim() || item.channelName.length > 200 || typeof item.protocol !== "string" || !idPattern.test(item.protocol) || !modelPattern.test(item.model ?? "") || (kind !== "image" && kind !== "video" && kind !== "audio") || !Array.isArray(item.modes) || !item.modes.length || !item.modes.every((mode) => modes.has(mode)) || !Number.isInteger(item.maxReferences) || item.maxReferences! < 0 || item.maxReferences! > 16) return null;
  const sizes = item.sizes ?? [];
  const ratios = item.ratios ?? [];
  const resolutions = item.resolutions ?? [];
  const durations = item.durations ?? [];
  if (!Array.isArray(sizes) || !sizes.every((size) => typeof size === "string" && sizePattern.test(size)) ||
    !Array.isArray(ratios) || !ratios.every((ratio) => typeof ratio === "string" && ratioPattern.test(ratio)) ||
    !Array.isArray(resolutions) || !resolutions.every((resolution) => typeof resolution === "string" && resolutionPattern.test(resolution)) ||
    !Array.isArray(durations) || !durations.every((duration) => Number.isInteger(duration) && duration > 0 && duration <= 900)) return null;
  return { channelId: item.channelId!, channelName: item.channelName, protocol: item.protocol, model: item.model!, kind, modes: [...new Set(item.modes)], sizes: [...new Set(sizes)], ratios: [...new Set(ratios)], resolutions: [...new Set(resolutions)], durations: [...new Set(durations)], maxReferences: item.maxReferences! };
}

export async function listMediaCapabilities(): Promise<MediaCapabilityCatalog> {
  const response = await authFetch("media-capabilities");
  const value = await response.json().catch(() => null) as { version?: unknown; models?: unknown } | null;
  if (!response.ok) throw new Error(`Media capability catalog unavailable: HTTP ${response.status}`);
  if (typeof value?.version !== "string" || !/^[a-f0-9]{64}$/.test(value.version) || !Array.isArray(value.models) || value.models.length > 1_000) throw new Error("Media capability catalog is invalid");
  const parsed = value.models.map(parseCapability);
  if (parsed.some((item) => item === null)) throw new Error("Media capability catalog is invalid");
  const catalog = parsed as MediaCapability[];
  if (new Set(catalog.map((item) => `${item.channelId}:${item.kind}:${item.model}`)).size !== catalog.length) throw new Error("Media capability catalog is invalid");
  return { version: value.version, models: catalog };
}

export function mediaOptionsForKind(catalog: MediaCapabilityCatalog, kind: MediaKind): Array<Omit<MediaCapability, "kind">> {
  return catalog.models.filter((item) => item.kind === kind).map(({ kind: _kind, ...item }) => ({ ...item, modes: [...item.modes], sizes: [...item.sizes], ratios: [...item.ratios], resolutions: [...item.resolutions], durations: [...item.durations] }));
}
