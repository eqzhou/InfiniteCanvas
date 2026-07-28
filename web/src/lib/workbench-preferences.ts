import { resolveProviderCapability } from "@/lib/provider-capabilities";
import type { AiProviderKind, PreferredModels } from "@/types/board";

const SAFE_CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODEL_MAX_LENGTH = 128;
const PREFERENCE_CHANNEL_LIMIT = 100;
const PROVIDER_KINDS: readonly AiProviderKind[] = ["text", "image", "video", "audio"];

export type ImageAspectPreset = "1:1" | "3:2" | "2:3";
export type ImageAspectSelection = ImageAspectPreset | "custom";

export const IMAGE_ASPECT_PRESETS: readonly Readonly<{
  aspect: ImageAspectPreset;
  label: string;
  pixelSize: string;
}>[] = Object.freeze([
  Object.freeze({ aspect: "1:1", label: "方形 1:1", pixelSize: "1024x1024" }),
  Object.freeze({ aspect: "3:2", label: "横向 3:2", pixelSize: "1536x1024" }),
  Object.freeze({ aspect: "2:3", label: "纵向 2:3", pixelSize: "1024x1536" }),
]);

function cleanModel(value: unknown): string {
  if (typeof value !== "string") return "";
  const model = value.trim();
  return model.length > 0 && model.length <= MODEL_MAX_LENGTH ? model : "";
}

export function normalizePreferredModels(value: unknown): PreferredModels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: PreferredModels = {};
  for (const [channelId, candidate] of Object.entries(value).slice(0, PREFERENCE_CHANNEL_LIMIT * 4)) {
    if (!SAFE_CHANNEL_ID.test(channelId) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const kinds = candidate as Record<string, unknown>;
    const preferences: Partial<Record<AiProviderKind, string>> = {};
    for (const kind of PROVIDER_KINDS) {
      const model = cleanModel(kinds[kind]);
      if (model) preferences[kind] = model;
    }
    if (Object.keys(preferences).length) normalized[channelId] = preferences;
    if (Object.keys(normalized).length >= PREFERENCE_CHANNEL_LIMIT) break;
  }
  return normalized;
}

export function withPreferredModel(
  current: Readonly<PreferredModels> | undefined,
  channelId: string,
  kind: AiProviderKind,
  model: string,
): PreferredModels {
  if (!SAFE_CHANNEL_ID.test(channelId)) return { ...(current ?? {}) };
  const cleaned = cleanModel(model);
  const channelPreferences = current?.[channelId] ?? {};
  if (!cleaned) {
    const { [kind]: _removed, ...remaining } = channelPreferences;
    if (Object.keys(remaining).length) return { ...(current ?? {}), [channelId]: remaining };
    const { [channelId]: _emptyChannel, ...otherChannels } = current ?? {};
    return otherChannels;
  }
  return {
    ...(current ?? {}),
    [channelId]: { ...channelPreferences, [kind]: cleaned },
  };
}

export function resolvePreferredModel(
  preferredModel: string | undefined,
  providerDefault: string | undefined,
  availableModels: readonly string[] | undefined,
): string {
  const preferred = cleanModel(preferredModel);
  const fallback = cleanModel(providerDefault);
  const available = [...new Set((availableModels ?? []).map(cleanModel).filter(Boolean))];
  if (!available.length) return preferred || fallback;
  if (preferred && available.includes(preferred)) return preferred;
  if (fallback && available.includes(fallback)) return fallback;
  return available[0] ?? "";
}

export function resolveImageSizeForAspect(
  aspect: ImageAspectPreset,
  protocol: string | undefined,
  model: string,
): string {
  const capability = resolveProviderCapability(protocol ?? "", "image", model);
  if (capability?.sizes?.includes(aspect)) return aspect;
  return IMAGE_ASPECT_PRESETS.find((preset) => preset.aspect === aspect)?.pixelSize ?? "1024x1024";
}

export function imageAspectForSize(size: string): ImageAspectSelection {
  const normalized = size.trim().toLowerCase();
  return IMAGE_ASPECT_PRESETS.find((preset) =>
    preset.aspect === normalized || preset.pixelSize === normalized)?.aspect ?? "custom";
}
