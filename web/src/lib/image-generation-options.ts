import { IMAGE_GENERATION_MAX_COUNT } from "@/lib/image-generation-batch";
import { resolveProviderCapability } from "@/lib/provider-capabilities";
import { IMAGE_ASPECT_PRESETS, type ImageAspectSelection } from "@/lib/workbench-preferences";

export type ImageGenerationOption = Readonly<{
  value: string;
  label: string;
}>;

function immutableOptions(options: ImageGenerationOption[]): readonly ImageGenerationOption[] {
  return Object.freeze(options.map((option) => Object.freeze({ ...option })));
}

export const IMAGE_SIZE_OPTIONS: readonly ImageGenerationOption[] = immutableOptions([
  { value: "1024x1024", label: "正方形 1:1 · 1024×1024" },
  { value: "1536x1024", label: "横屏 3:2 · 1536×1024" },
  { value: "1024x1536", label: "竖屏 2:3 · 1024×1536" },
  { value: "1024x768", label: "横屏 4:3 · 1024×768" },
  { value: "768x1024", label: "竖屏 3:4 · 768×1024" },
  { value: "1536x864", label: "横屏 16:9 · 1536×864" },
  { value: "864x1536", label: "竖屏 9:16 · 864×1536" },
  { value: "1792x768", label: "超宽屏 21:9 · 1792×768" },
  { value: "1280x1024", label: "横屏 5:4 · 1280×1024" },
  { value: "1024x1280", label: "竖屏 4:5 · 1024×1280" },
]);

/**
 * Return only the dimensions represented by a known provider contract. The
 * generic list remains available for user-configured/unknown providers, where
 * the remote service is the authority for accepted dimensions.
 */
export function imageSizeOptionsFor(
  protocol: string | undefined,
  model: string | undefined,
): readonly ImageGenerationOption[] {
  const capability = resolveProviderCapability(protocol ?? "", "image", model ?? "");
  if (!capability?.sizes?.length) return IMAGE_SIZE_OPTIONS;
  const supported = new Set(capability.sizes);
  return immutableOptions(
    [
      ...(supported.has("auto") ? [{ value: "auto", label: "自动 / 自适应" }] : []),
      ...IMAGE_SIZE_OPTIONS,
    ].flatMap((option) => {
      if (option.value === "auto") return [option];
      const preset = IMAGE_ASPECT_PRESETS.find((candidate) => candidate.pixelSize === option.value);
      if (!preset || !supported.has(preset.aspect)) return [];
      // Persist pixel dimensions across channels. APIMart's server adapter
      // converts these dimensions to its native ratio strings, while OpenAI
      // compatible endpoints continue to receive the documented pixel form.
      return [option];
    }),
  );
}

export function imageAspectOptionsFor(
  protocol: string | undefined,
  model: string | undefined,
): readonly typeof IMAGE_ASPECT_PRESETS[number][] {
  const capability = resolveProviderCapability(protocol ?? "", "image", model ?? "");
  if (!capability?.sizes?.length) return IMAGE_ASPECT_PRESETS;
  const supported = new Set(capability.sizes);
  return Object.freeze(IMAGE_ASPECT_PRESETS.filter((preset) => supported.has(preset.aspect)));
}

export function normalizeImageAspectForProvider(
  value: ImageAspectSelection,
  protocol: string | undefined,
  model: string | undefined,
): ImageAspectSelection {
  if (value === "custom") return value;
  const options = imageAspectOptionsFor(protocol, model);
  return options.some((option) => option.aspect === value) ? value : options[0]?.aspect ?? "custom";
}

/** Convert legacy/provider-native ratio values to the channel-neutral pixel form. */
export function normalizeImageSizeForProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "1024x1024";
  return IMAGE_ASPECT_PRESETS.find((preset) => preset.aspect === normalized)?.pixelSize ?? normalized;
}

export const IMAGE_QUALITY_OPTIONS: readonly ImageGenerationOption[] = immutableOptions([
  { value: "auto", label: "自动（推荐）" },
  { value: "low", label: "低质量 · 更快" },
  { value: "medium", label: "中等质量" },
  { value: "high", label: "高质量 · 更慢" },
]);

const LEGACY_IMAGE_RESOLUTION_VALUES = new Set(["1K", "2K", "4K"]);

function canonicalImageResolution(value: string): string {
  const trimmed = value.trim();
  const match = [...LEGACY_IMAGE_RESOLUTION_VALUES].find((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed;
}

/** Values formerly persisted in image `quality` and now carried by `resolution`. */
export function legacyImageResolutionFromQuality(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = canonicalImageResolution(value);
  return LEGACY_IMAGE_RESOLUTION_VALUES.has(normalized) ? normalized : undefined;
}

const QUALITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  auto: "自动（推荐）",
  low: "低质量 · 更快",
  medium: "中等质量",
  high: "高质量 · 更慢",
});

/**
 * Return the quality control values accepted by the selected provider/model.
 * Resolution values are intentionally not mixed into this list. A known
 * contract with no quality field returns an empty list so the UI does not
 * invent controls that the provider did not declare.
 */
export function imageQualityOptionsFor(
  protocol: string | undefined,
  model: string | undefined,
): readonly ImageGenerationOption[] {
  const capability = resolveProviderCapability(protocol ?? "", "image", model ?? "");
  if (capability?.qualities?.length) {
    return immutableOptions(capability.qualities.map((value) => ({
      value,
      label: QUALITY_LABELS[value] ?? value,
    })));
  }
  if (capability) return [];
  return IMAGE_QUALITY_OPTIONS;
}

/** Return only resolutions explicitly declared by a known image contract. */
export function imageResolutionOptionsFor(
  protocol: string | undefined,
  model: string | undefined,
): readonly ImageGenerationOption[] {
  const capability = resolveProviderCapability(protocol ?? "", "image", model ?? "");
  if (!capability?.resolutions?.length) return [];
  return immutableOptions(capability.resolutions.map((value) => ({
    value,
    label: `${value} 分辨率`,
  })));
}

/** Normalize a resolution without adding values to a provider's contract. */
export function normalizeImageResolutionForProvider(
  value: string | undefined,
  protocol: string | undefined,
  model: string | undefined,
): string {
  const current = canonicalImageResolution(value ?? "");
  const capability = resolveProviderCapability(protocol ?? "", "image", model ?? "");
  if (!capability) return current;
  const options = capability.resolutions ?? [];
  if (!current) {
    // Keep the UI's explicit default aligned with the protected server
    // adapter. Seedream defaults to 2K while Gemini Lite only exposes 1K.
    if (capability.family === "seedream-5.0-pro" && options.includes("2K")) return "2K";
    return options[0] ?? "";
  }
  return options.includes(current) ? current : options[0] ?? "";
}

/** Keep legacy custom values for unknown providers, but fail closed for known contracts. */
export function normalizeImageQualityForProvider(
  value: string,
  protocol: string | undefined,
  model: string | undefined,
): string {
  const current = value.trim();
  if (!current) return "auto";
  const options = imageQualityOptionsFor(protocol, model);
  if (options.some((option) => option.value === current)) return current;
  const capability = resolveProviderCapability(protocol ?? "", "image", model ?? "");
  if (!capability) return current;
  // A resolution-only contract has no verified quality vocabulary. Preserve
  // legacy quality values in saved records instead of silently changing their
  // meaning; the request layer can omit the field when the provider declares
  // no qualities.
  if (!capability.qualities?.length) return current;
  if (capability.qualities?.length && !capability.qualities.includes("auto")) {
    return capability.qualities.includes("medium") ? "medium" : capability.qualities[0] ?? "auto";
  }
  return "auto";
}

export function imageOutputLimitFor(
  _protocol?: string,
  _model?: string,
  fallback = IMAGE_GENERATION_MAX_COUNT,
): number {
  // Each image is an independent n=1 request, so model maxOutputs no longer
  // caps how many variants the workbench or canvas may request.
  return fallback > 0 ? fallback : IMAGE_GENERATION_MAX_COUNT;
}

export function clampImageCountForProvider(
  count: number,
  protocol: string | undefined,
  model: string | undefined,
  fallback = IMAGE_GENERATION_MAX_COUNT,
): number {
  const limit = imageOutputLimitFor(protocol, model, fallback);
  const requested = Number.isFinite(count) ? Math.floor(count) : 1;
  return Math.min(limit, Math.max(1, requested));
}

export function optionsWithCurrentValue(
  options: readonly ImageGenerationOption[],
  currentValue: string,
): readonly ImageGenerationOption[] {
  if (!currentValue || options.some((option) => option.value === currentValue)) return options;
  return Object.freeze([
    Object.freeze({ value: currentValue, label: `当前自定义：${currentValue}` }),
    ...options,
  ]);
}
