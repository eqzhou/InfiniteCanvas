import type { CameraPromptConfig, NodeMetadata } from "@/types/board";

export type ImageGenerationRequest = {
  prompt: string;
  model: string;
  size: string;
  quality: string;
  count: number;
  transparentBackground: boolean;
  referenceStorageKeys: readonly string[];
  cameraPrompt?: CameraPromptConfig;
};

export type ImageGenerationMetadata = {
  prompt: string;
  requestPrompt?: string;
  model: string;
  size: string;
  quality: string;
  count: number;
  transparentBackground: boolean;
  generationType: NonNullable<NodeMetadata["generationType"]>;
  referenceStorageKeys: string[];
  cameraPrompt?: CameraPromptConfig;
};

export function createImageGenerationMetadata(
  request: ImageGenerationRequest,
): ImageGenerationMetadata {
  const referenceStorageKeys = [...request.referenceStorageKeys];
  return {
    prompt: request.prompt,
    model: request.model,
    size: request.size,
    quality: request.quality,
    count: request.count,
    transparentBackground: request.transparentBackground,
    generationType: referenceStorageKeys.length ? "image-to-image" : "text-to-image",
    referenceStorageKeys,
    cameraPrompt: request.cameraPrompt ? { ...request.cameraPrompt } : undefined,
  };
}

export function assertResolvedImageReferences(
  referenceStorageKeys: readonly string[],
  resolvedReferences: readonly string[],
): void {
  if (resolvedReferences.length !== referenceStorageKeys.length) {
    throw new Error("参考图已丢失或无法恢复，请重新连接有效图片后再生成");
  }
}
