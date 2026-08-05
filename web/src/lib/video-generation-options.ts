import { resolveProviderCapability } from "@/lib/provider-capabilities";

export type VideoGenerationOption = Readonly<{
  value: string;
  label: string;
}>;

function immutableOptions(options: VideoGenerationOption[]): readonly VideoGenerationOption[] {
  return Object.freeze(options.map((option) => Object.freeze({ ...option })));
}

export const VIDEO_RATIO_OPTIONS: readonly VideoGenerationOption[] = immutableOptions([
  { value: "16:9", label: "横屏 · 16:9" },
  { value: "9:16", label: "竖屏 · 9:16" },
  { value: "1:1", label: "方形 · 1:1" },
  { value: "4:3", label: "横屏 · 4:3" },
  { value: "3:4", label: "竖屏 · 3:4" },
  { value: "21:9", label: "超宽屏 · 21:9" },
  { value: "adaptive", label: "自适应" },
]);

export const VIDEO_RESOLUTION_OPTIONS: readonly VideoGenerationOption[] = immutableOptions([
  { value: "480p", label: "480p · 经济" },
  { value: "720p", label: "720p · 高清" },
  { value: "1080p", label: "1080p · 全高清" },
  { value: "4k", label: "4K · 超高清" },
]);

function capabilityOptions(
  values: readonly string[] | undefined,
  fallback: readonly VideoGenerationOption[],
  suffix: string,
): readonly VideoGenerationOption[] {
  if (!values?.length) return fallback;
  return immutableOptions(values.map((value) => ({ value, label: `${value}${suffix}` })));
}

export function videoRatioOptionsFor(
  protocol: string | undefined,
  model: string | undefined,
): readonly VideoGenerationOption[] {
  return capabilityOptions(
    resolveProviderCapability(protocol ?? "", "video", model ?? "")?.video?.aspectRatios,
    VIDEO_RATIO_OPTIONS,
    "",
  );
}

export function videoResolutionOptionsFor(
  protocol: string | undefined,
  model: string | undefined,
): readonly VideoGenerationOption[] {
  return capabilityOptions(
    resolveProviderCapability(protocol ?? "", "video", model ?? "")?.video?.resolutions,
    VIDEO_RESOLUTION_OPTIONS,
    " 分辨率",
  );
}

export function normalizeVideoRatioForProvider(
  value: string,
  protocol: string | undefined,
  model: string | undefined,
): string {
  const current = value.trim();
  if (!current) return "16:9";
  const capability = resolveProviderCapability(protocol ?? "", "video", model ?? "")?.video;
  if (!capability) return current;
  return capability.aspectRatios.includes(current) ? current : capability.aspectRatios[0] ?? "16:9";
}

export function normalizeVideoResolutionForProvider(
  value: string,
  protocol: string | undefined,
  model: string | undefined,
): string {
  const current = value.trim();
  if (!current) return "720p";
  const capability = resolveProviderCapability(protocol ?? "", "video", model ?? "")?.video;
  if (!capability?.resolutions?.length) return current;
  return capability.resolutions.includes(current) ? current : capability.resolutions[0] ?? "720p";
}

const RESOLUTION_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "4k": 2160,
});

export function videoSizePresetFor(ratio: string, resolution: string): string {
  const normalizedRatio = ratio.trim().toLowerCase();
  const normalizedResolution = resolution.trim().toLowerCase();
  if (normalizedRatio === "adaptive") return "adaptive";
  const height = RESOLUTION_HEIGHTS[normalizedResolution];
  if (!height) return "auto";
  const dimensions: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
    "16:9": [16, 9],
    "9:16": [9, 16],
    "1:1": [1, 1],
    "4:3": [4, 3],
    "3:4": [3, 4],
    "21:9": [21, 9],
  });
  const dimensionsForRatio = dimensions[normalizedRatio];
  if (!dimensionsForRatio) return "auto";
  const [widthRatio, heightRatio] = dimensionsForRatio;
  const shortSide = height;
  const longSide = Math.round((shortSide * Math.max(widthRatio, heightRatio)) / Math.min(widthRatio, heightRatio) / 2) * 2;
  const width = widthRatio >= heightRatio ? longSide : shortSide;
  const outputHeight = widthRatio >= heightRatio ? shortSide : longSide;
  return `${width}x${outputHeight}`;
}

/**
 * Keep the persisted size compatible with the current adapter. APIMart
 * adapters receive the native ratio in `size`; template adapters receive the
 * linked pixel preset; Ark reads ratio/resolution directly and ignores size.
 */
export function videoSizeForProvider(
  protocol: string | undefined,
  ratio: string,
  resolution: string,
): string {
  if (protocol === "apimart") return ratio.trim() || "16:9";
  if (protocol === "ark") return "";
  return videoSizePresetFor(ratio, resolution);
}

export function videoSizeAfterSelectionChange(
  protocol: string | undefined,
  currentSize: string | undefined,
  previousRatio: string,
  previousResolution: string,
  nextRatio: string,
  nextResolution: string,
): string {
  const current = currentSize?.trim() ?? "";
  const previousAuto = videoSizeForProvider(protocol, previousRatio, previousResolution);
  if (current && current !== previousAuto) return current;
  return videoSizeForProvider(protocol, nextRatio, nextResolution);
}

export function optionsWithCurrentVideoValue(
  options: readonly VideoGenerationOption[],
  currentValue: string,
): readonly VideoGenerationOption[] {
  if (!currentValue || options.some((option) => option.value === currentValue)) return options;
  return Object.freeze([
    Object.freeze({ value: currentValue, label: `当前自定义：${currentValue}` }),
    ...options,
  ]);
}
