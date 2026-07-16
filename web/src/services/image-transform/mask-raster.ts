import { IMAGE_TRANSFORM_LIMITS } from "./types";

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function validateNormalizedRect(rect: NormalizedRect): void {
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 ||
      rect.x > 1 || rect.y > 1 || rect.w > 1 || rect.h > 1) {
    throw new Error("Mask rectangle must use positive normalized coordinates");
  }
  if (rect.x + rect.w > 1 + Number.EPSILON || rect.y + rect.h > 1 + Number.EPSILON) {
    throw new Error("Mask rectangle exceeds image bounds");
  }
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid mask dimensions");
  }
  if (width * height > IMAGE_TRANSFORM_LIMITS.maxPixels) throw new Error("Mask exceeds the pixel limit");
}

/** OpenAI image edits use transparent mask pixels for the area to regenerate. */
export function rasterizeRectEditMask(
  width: number,
  height: number,
  rect: NormalizedRect,
): Uint8ClampedArray<ArrayBuffer> {
  validateDimensions(width, height);
  validateNormalizedRect(rect);
  const pixels: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(
    new ArrayBuffer(width * height * 4),
  );
  const left = Math.round(rect.x * width);
  const top = Math.round(rect.y * height);
  const right = Math.round((rect.x + rect.w) * width);
  const bottom = Math.round((rect.y + rect.h) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = x >= left && x < right && y >= top && y < bottom ? 0 : 255;
    }
  }
  return pixels;
}

export async function createRectEditMaskBlob(
  width: number,
  height: number,
  rect: NormalizedRect,
): Promise<Blob> {
  const pixels = rasterizeRectEditMask(width, height, rect);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Failed to encode mask")), "image/png");
  });
}
