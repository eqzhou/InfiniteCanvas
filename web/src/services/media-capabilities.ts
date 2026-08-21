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
const imageSizePattern = /^(?:\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2}|auto)$/;
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
  const acceptedSizePattern = kind === "image" ? imageSizePattern : sizePattern;
  if (!Array.isArray(sizes) || !sizes.every((size) => typeof size === "string" && acceptedSizePattern.test(size)) ||
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

export function intersectMediaCapabilities(items: readonly MediaCapability[]): MediaCapability | undefined {
  const first = items[0];
  if (!first) return undefined;
  const common = <T extends string | number>(select: (item: MediaCapability) => readonly T[]): T[] => {
    const constrained = items.map(select).filter((values) => values.length > 0);
    if (!constrained.length) return [];
    return constrained[0]!.filter((value) => constrained.every((values) => values.includes(value)));
  };
  const modes = common((item) => item.modes);
  const sizes = common((item) => item.sizes);
  const ratios = common((item) => item.ratios);
  const resolutions = common((item) => item.resolutions);
  const durations = common((item) => item.durations);
  const imageResolutionDeclared = items.some((item) => item.kind === "image" && item.resolutions.length > 0);
  const imageResolutionMissing = items.some((item) => item.kind === "image" && item.resolutions.length === 0);
  if (!modes.length ||
    (items.some((item) => item.sizes.length) && !sizes.length) ||
    (items.some((item) => item.ratios.length) && !ratios.length) ||
    (items.some((item) => item.resolutions.length) && !resolutions.length) ||
    (imageResolutionDeclared && imageResolutionMissing) ||
    (items.some((item) => item.durations.length) && !durations.length)) return undefined;
  return {
    ...first,
    channelId: "shared-auto",
    channelName: "Auto",
    modes,
    sizes,
    ratios,
    resolutions,
    durations,
    maxReferences: Math.min(...items.map((item) => item.maxReferences)),
  };
}

export function resolveMediaCapabilityForRequest(
  catalog: MediaCapabilityCatalog | null | undefined,
  channelId: string,
  kind: MediaKind,
  model: string,
  mode: MediaGenerationMode,
): MediaCapability | undefined {
  const matching = catalog?.models.filter((item) =>
    item.kind === kind && item.model === model && item.modes.includes(mode) &&
    (channelId === "shared-auto" || item.channelId === channelId),
  ) ?? [];
  return channelId === "shared-auto" ? intersectMediaCapabilities(matching) : matching[0];
}

/**
 * Normalize an image resolution only against a declared capability snapshot.
 * An explicit capability with no resolutions is intentionally resolution-less
 * instead of falling back to a guessed provider preset.
 */
export function normalizeImageResolutionForCapability(
  capability: MediaCapability | undefined,
  requested: string,
): string {
  if (!capability) return requested;
  if (!capability.resolutions.length) return "";
  return capability.resolutions.includes(requested)
    ? requested
    : capability.resolutions[0] ?? "";
}
