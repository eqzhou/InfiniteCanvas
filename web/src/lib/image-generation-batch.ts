/** Operational ceiling after each image is its own n=1 request. */
export const IMAGE_GENERATION_MAX_COUNT = 100;

export function imageGenerationBatchCount(
  count: unknown,
  max = IMAGE_GENERATION_MAX_COUNT,
): number {
  const value = typeof count === "number" ? count : Number(count);
  if (!Number.isSafeInteger(value)) return 1;
  return Math.min(max, Math.max(1, value));
}

export type ImageGenerationSlotParameters<T extends Record<string, unknown>> = T & {
  count: 1;
  requestedCount: number;
  batchId: string;
  batchIndex: number;
};

export function imageGenerationSlotParameters<T extends Record<string, unknown>>(
  parameters: T,
  index: number,
  total: number,
  batchId: string,
): ImageGenerationSlotParameters<T> {
  const size = imageGenerationBatchCount(total);
  const slot = Math.min(size, Math.max(1, index + 1));
  return {
    ...parameters,
    count: 1,
    requestedCount: size,
    batchId: size > 1 ? batchId : "",
    batchIndex: size > 1 ? slot : 0,
  };
}

export function workbenchImageCountFromParameters(
  parameters: Record<string, unknown> | undefined,
  fallback?: number,
): number {
  const requested = parameters?.requestedCount;
  if (typeof requested === "number" && Number.isSafeInteger(requested) && requested >= 1) {
    return imageGenerationBatchCount(requested);
  }
  const count = parameters?.count;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 1) {
    return imageGenerationBatchCount(count);
  }
  return fallback === undefined ? 1 : imageGenerationBatchCount(fallback);
}
