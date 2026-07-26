export type ImageTransformCapability = "upscale" | "inpaint" | "mask";
export type ImageTransformOperation = "resize" | "ai-upscale" | "inpaint" | "mask";

export interface ImageTransformContext {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export interface ImageTransformResult {
  blob: Blob;
  provider: string;
  model?: string;
  requestId?: string;
  width?: number;
  height?: number;
  metrics?: Readonly<Record<string, number>>;
}

export interface UpscaleRequest {
  image: Blob;
  scale: number;
  width: number;
  height: number;
}

export interface InpaintRequest {
  image: Blob;
  mask: Blob;
  prompt: string;
  width: number;
  height: number;
}

export interface LocalMaskRequest {
  image: Blob;
  rect: { x: number; y: number; w: number; h: number };
  mode: "keep" | "remove";
  width: number;
  height: number;
}

export interface ImageTransformProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "cloud";
  readonly capabilities: Readonly<Record<ImageTransformCapability, boolean>>;
  upscale?: (request: UpscaleRequest, context: ImageTransformContext) => Promise<ImageTransformResult>;
  inpaint?: (request: InpaintRequest, context: ImageTransformContext) => Promise<ImageTransformResult>;
  mask?: (request: LocalMaskRequest, context: ImageTransformContext) => Promise<ImageTransformResult>;
}

export const IMAGE_TRANSFORM_LIMITS = {
  maxInputBytes: 32 * 1024 * 1024,
  maxOutputBytes: 32 * 1024 * 1024,
  maxPixels: 64 * 1024 * 1024,
  maxPromptChars: 4_000,
  minScale: 1,
  maxScale: 4,
} as const;

export function validateImageInput(blob: Blob, width: number, height: number): void {
  if (!blob.type.toLowerCase().startsWith("image/")) throw new Error("Input must be an image");
  if (blob.size <= 0 || blob.size > IMAGE_TRANSFORM_LIMITS.maxInputBytes) {
    throw new Error("Input image exceeds the byte limit");
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid image dimensions");
  }
  if (width * height > IMAGE_TRANSFORM_LIMITS.maxPixels) throw new Error("Image exceeds the pixel limit");
}

export function validateUpscaleRequest(request: UpscaleRequest): void {
  validateImageInput(request.image, request.width, request.height);
  if (!Number.isFinite(request.scale) || request.scale < IMAGE_TRANSFORM_LIMITS.minScale || request.scale > IMAGE_TRANSFORM_LIMITS.maxScale) {
    throw new Error("Invalid upscale scale");
  }
  const outputWidth = Math.round(request.width * request.scale);
  const outputHeight = Math.round(request.height * request.scale);
  if (!Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight) ||
      outputWidth * outputHeight > IMAGE_TRANSFORM_LIMITS.maxPixels) {
    throw new Error("Upscale output exceeds the pixel limit");
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function progressReporter(callback?: (progress: number) => void): (value: number) => void {
  let last = -1;
  return (value) => {
    const next = Math.max(last, Math.min(1, Math.max(0, value)));
    if (next === last) return;
    last = next;
    callback?.(next);
  };
}
