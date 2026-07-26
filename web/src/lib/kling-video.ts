import { resolveProviderCapability } from "@/lib/provider-capabilities";

export type KlingVideoMode = "std" | "pro" | "4k";
export type KlingShotType = "intelligence" | "customize";

export type KlingVideoShot = Readonly<{
  index: number;
  prompt: string;
  duration: number;
}>;

export type KlingVideoElement = Readonly<{
  name: string;
  description: string;
  imageUrls: readonly string[];
}>;

export type KlingVideoParameters = Readonly<{
  model: "kling-v2-6" | "kling-v3";
  prompt: string;
  negativePrompt: string;
  mode: KlingVideoMode;
  duration: number;
  aspectRatio: string;
  audio: boolean;
  watermark: boolean;
  imageUrls: readonly string[];
  multiShot: boolean;
  shotType: KlingShotType;
  shots: readonly KlingVideoShot[];
  elements: readonly KlingVideoElement[];
}>;

function normalizeURL(value: string): string {
  return value.trim();
}

export function normalizeKlingVideoParameters(input: KlingVideoParameters): KlingVideoParameters {
  const multiShot = input.model === "kling-v3" && input.multiShot;
  return {
    ...input,
    prompt: input.prompt.trim(),
    negativePrompt: input.negativePrompt.trim(),
    imageUrls: input.imageUrls.map(normalizeURL),
    multiShot,
    shots: multiShot && input.shotType === "customize"
      ? input.shots.map((shot) => ({ ...shot, prompt: shot.prompt.trim() }))
      : [],
    elements: input.model === "kling-v3"
      ? input.elements.map((element) => ({
          ...element,
          name: element.name.trim(),
          description: element.description.trim(),
          imageUrls: element.imageUrls.map(normalizeURL),
        }))
      : [],
  };
}

function validPublicHTTPSURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

function validateURLs(values: readonly string[], label: string): void {
  if (values.some((value) => !validPublicHTTPSURL(value))) throw new Error(`${label} URL 无效`);
}

export function validateKlingVideoParameters(input: KlingVideoParameters): KlingVideoParameters {
  const value = normalizeKlingVideoParameters(input);
  const capability = resolveProviderCapability("apimart", "video", value.model)?.video;
  if (!capability) throw new Error("不支持的 Kling 模型");
  if (value.prompt.length > 2_500) throw new Error("提示词过长");
  if (value.negativePrompt.length > 2_500) throw new Error("负面提示词过长");
  if (!capability.modes.includes(value.mode)) throw new Error("当前模型不支持所选生成模式");
  if (!capability.aspectRatios.includes(value.aspectRatio)) throw new Error("当前模型不支持所选比例");
  if (value.imageUrls.length > capability.maxImageReferences) throw new Error("参考图片数量超出限制");
  validateURLs(value.imageUrls, "参考图片");

  if (capability.durations && !capability.durations.includes(value.duration)) {
    throw new Error("Kling 2.6 仅支持 5 或 10 秒");
  }
  if ((capability.minDuration !== undefined && value.duration < capability.minDuration) ||
      (capability.maxDuration !== undefined && value.duration > capability.maxDuration) ||
      !Number.isSafeInteger(value.duration)) {
    throw new Error("视频时长超出模型限制");
  }
  if (value.audio && !capability.audioModes.includes(value.mode)) throw new Error("标准模式不支持音频");
  if (value.imageUrls.length === 2 && !capability.lastFrameModes.includes(value.mode)) throw new Error("标准模式不支持尾帧");
  if (value.model === "kling-v2-6" && value.audio && value.imageUrls.length === 2) {
    throw new Error("Kling 2.6 尾帧与音频不能同时使用");
  }

  if (value.multiShot) {
    if (value.shotType !== "customize" && value.shotType !== "intelligence") throw new Error("镜头拆分方式无效");
    if (value.shotType === "customize") {
      if (value.shots.length < 1 || value.shots.length > capability.maxShots) throw new Error("自定义镜头数量超出限制");
      let totalDuration = 0;
      for (const [offset, shot] of value.shots.entries()) {
        if (shot.index !== offset + 1) throw new Error("镜头序号必须从 1 连续排列");
        if (!shot.prompt || shot.prompt.length > 512) throw new Error("镜头提示词无效");
        if (!Number.isSafeInteger(shot.duration) || shot.duration < 1 || shot.duration > value.duration) throw new Error("镜头时长无效");
        totalDuration += shot.duration;
      }
      if (totalDuration !== value.duration) throw new Error("镜头时长总和必须等于视频时长");
    }
  }

  if (value.elements.length > capability.maxElements) throw new Error("参考元素数量超出限制");
  const elementNames = new Set<string>();
  for (const element of value.elements) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(element.name) || elementNames.has(element.name)) {
      throw new Error("参考元素名称无效或重复");
    }
    elementNames.add(element.name);
    if (!element.description || element.description.length > 1_000) throw new Error("参考元素描述无效");
    if (element.imageUrls.length < 2 || element.imageUrls.length > 4) throw new Error("每个元素需要 2-4 张参考图片");
    validateURLs(element.imageUrls, "元素参考图片");
  }
  if (!value.prompt && !(value.multiShot && value.shotType === "customize")) throw new Error("请输入提示词");
  return value;
}
