import type { CameraPromptConfig, NodeMetadata } from "@/types/board";

export type ImageGenerationRequest = {
  prompt: string;
  model: string;
  size: string;
  quality: string;
  count: number;
  transparentBackground: boolean;
  referenceStorageKeys: readonly string[];
  generationChannelId?: string;
  cameraPrompt?: CameraPromptConfig;
};

export type ImageGenerationMetadata = {
  prompt: string;
  model: string;
  size: string;
  quality: string;
  count: number;
  transparentBackground: boolean;
  generationType: NonNullable<NodeMetadata["generationType"]>;
  referenceStorageKeys: string[];
  generationChannelId?: string;
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
    generationChannelId: request.generationChannelId,
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

export function canRetryImageResult(
  metadata: Pick<NodeMetadata, "status" | "prompt" | "isBatchRoot" | "batchChildIds">,
): boolean {
  return metadata.status === "error" &&
    Boolean(metadata.prompt) &&
    !metadata.isBatchRoot &&
    !metadata.batchChildIds?.length;
}
