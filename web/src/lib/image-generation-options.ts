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

const QUALITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  auto: "自动（推荐）",
  low: "低质量 · 更快",
  medium: "中等质量",
  high: "高质量 · 更慢",
});

/**
 * Return the quality control values accepted by the selected provider/model.
 * APIMart's current Seedream/Gemini image contracts call this field
 * `resolution` and accept 1K/2K, while GPT Image uses auto/low/medium/high.
 */
export function imageQualityOptionsFor(
  protocol: string | undefined,
  model: string | undefined,
): readonly ImageGenerationOption[] {
  const capability = resolveProviderCapability(protocol ?? "", "image", model ?? "");
  if (capability?.resolutions?.length) {
    return immutableOptions([
      { value: "auto", label: "自动（模型默认）" },
      ...capability.resolutions.map((value) => ({
        value,
        label: `${value} 分辨率`,
      })),
    ]);
  }
  if (capability?.qualities?.length) {
    return immutableOptions(capability.qualities.map((value) => ({
      value,
      label: QUALITY_LABELS[value] ?? value,
    })));
  }
  return IMAGE_QUALITY_OPTIONS;
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
  if (capability.qualities?.length && !capability.qualities.includes("auto")) {
    return capability.qualities.includes("medium") ? "medium" : capability.qualities[0] ?? "auto";
  }
  return "auto";
}

export function imageOutputLimitFor(
  protocol: string | undefined,
  model: string | undefined,
  fallback = 8,
): number {
  const maxOutputs = resolveProviderCapability(protocol ?? "", "image", model ?? "")?.maxOutputs;
  return maxOutputs && maxOutputs > 0 ? Math.min(fallback, maxOutputs) : fallback;
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
