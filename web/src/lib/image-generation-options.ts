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
]);

export const IMAGE_QUALITY_OPTIONS: readonly ImageGenerationOption[] = immutableOptions([
  { value: "auto", label: "自动（推荐）" },
  { value: "low", label: "低质量 · 更快" },
  { value: "medium", label: "中等质量" },
  { value: "high", label: "高质量 · 更慢" },
]);

export function optionsWithCurrentValue(
  options: readonly ImageGenerationOption[],
  currentValue: string,
): readonly ImageGenerationOption[] {
  if (!currentValue || options.some((option) => option.value === currentValue)) return options;
  return [{ value: currentValue, label: `当前自定义：${currentValue}` }, ...options];
}
