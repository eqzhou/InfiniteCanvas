import type { CameraPromptConfig, NodeMetadata } from "@/types/board";
import {
  imageOutputLimitFor,
  legacyImageResolutionFromQuality,
  normalizeImageQualityForProvider,
  normalizeImageResolutionForProvider,
  normalizeImageSizeForProvider,
} from "@/lib/image-generation-options";

export type ImageGenerationRequest = {
  prompt: string;
  model: string;
  size: string;
  quality: string;
  /** Provider-declared image resolution, independent from pixel size and quality. */
  resolution?: string;
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
  resolution?: string;
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
  const legacyResolution = legacyImageResolutionFromQuality(request.quality);
  const resolution = request.resolution?.trim() || legacyResolution;
  return {
    prompt: request.prompt,
    model: request.model,
    size: normalizeImageSizeForProvider(request.size),
    quality: legacyResolution ? "auto" : request.quality,
    ...(resolution ? { resolution } : {}),
    count: request.count,
    transparentBackground: request.transparentBackground,
    generationType: referenceStorageKeys.length ? "image-to-image" : "text-to-image",
    referenceStorageKeys,
    generationChannelId: request.generationChannelId,
    cameraPrompt: request.cameraPrompt ? { ...request.cameraPrompt } : undefined,
  };
}

/**
 * Normalize a saved/request snapshot immediately before it crosses a provider
 * boundary. Older canvas data can contain a generic quality, ratio, or output
 * count that is not accepted by the selected model. Keeping this at the
 * shared metadata boundary prevents individual UI entry points from drifting.
 */
export function normalizeImageGenerationForProvider(
  generation: ImageGenerationMetadata,
  protocol: string | undefined,
): ImageGenerationMetadata {
  const requestedCount = Number(generation.count);
  const count = Math.min(
    Math.max(1, Number.isFinite(requestedCount) ? Math.floor(requestedCount) : 1),
    imageOutputLimitFor(protocol, generation.model),
  );
  const legacyResolution = legacyImageResolutionFromQuality(generation.quality);
  const resolution = normalizeImageResolutionForProvider(
    generation.resolution ?? legacyResolution,
    protocol,
    generation.model,
  );
  return {
    ...generation,
    size: normalizeImageSizeForProvider(generation.size),
    quality: normalizeImageQualityForProvider(
      legacyResolution ? "auto" : generation.quality,
      protocol,
      generation.model,
    ),
    ...(resolution ? { resolution } : {}),
    count,
    referenceStorageKeys: [...generation.referenceStorageKeys],
    cameraPrompt: generation.cameraPrompt ? { ...generation.cameraPrompt } : undefined,
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
