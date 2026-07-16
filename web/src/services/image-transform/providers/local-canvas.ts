import { validateNormalizedRect } from "../mask-raster";
import {
  progressReporter,
  throwIfAborted,
  validateImageInput,
  validateUpscaleRequest,
  type ImageTransformProvider,
} from "../types";

async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // HTMLImageElement accepts a few browser-decodable images rejected by createImageBitmap.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to decode image"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Failed to encode image")), "image/png");
  });
}

export function createLocalCanvasTransformProvider(): ImageTransformProvider {
  return {
    id: "local-canvas",
    label: "本地 Canvas",
    kind: "local",
    capabilities: { upscale: true, inpaint: false, mask: true },
    async upscale(request, context) {
      validateUpscaleRequest(request);
      const progress = progressReporter(context.onProgress);
      throwIfAborted(context.signal);
      progress(0);
      const image = await decodeImage(request.image);
      try {
        throwIfAborted(context.signal);
        progress(0.3);
        const width = Math.max(1, Math.round(request.width * request.scale));
        const height = Math.max(1, Math.round(request.height * request.scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const drawing = canvas.getContext("2d");
        if (!drawing) throw new Error("Canvas unavailable");
        drawing.imageSmoothingEnabled = true;
        drawing.imageSmoothingQuality = "high";
        drawing.drawImage(image, 0, 0, width, height);
        progress(0.75);
        const blob = await toBlob(canvas);
        throwIfAborted(context.signal);
        progress(1);
        return { blob, provider: "local-canvas", model: "browser-bicubic", width, height };
      } finally {
        if ("close" in image && typeof image.close === "function") image.close();
      }
    },
    async mask(request, context) {
      validateImageInput(request.image, request.width, request.height);
      validateNormalizedRect(request.rect);
      const progress = progressReporter(context.onProgress);
      throwIfAborted(context.signal);
      progress(0);
      const image = await decodeImage(request.image);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = request.width;
        canvas.height = request.height;
        const drawing = canvas.getContext("2d", { willReadFrequently: true });
        if (!drawing) throw new Error("Canvas unavailable");
        drawing.drawImage(image, 0, 0, request.width, request.height);
        progress(0.3);
        const data = drawing.getImageData(0, 0, request.width, request.height);
        const left = Math.round(request.rect.x * request.width);
        const top = Math.round(request.rect.y * request.height);
        const right = Math.round((request.rect.x + request.rect.w) * request.width);
        const bottom = Math.round((request.rect.y + request.rect.h) * request.height);
        for (let y = 0; y < request.height; y += 1) {
          throwIfAborted(context.signal);
          for (let x = 0; x < request.width; x += 1) {
            const inside = x >= left && x < right && y >= top && y < bottom;
            const clear = request.mode === "keep" ? !inside : inside;
            if (clear) data.data[(y * request.width + x) * 4 + 3] = 0;
          }
          if (y % 32 === 0) progress(0.3 + 0.45 * (y / request.height));
        }
        drawing.putImageData(data, 0, 0);
        const blob = await toBlob(canvas);
        throwIfAborted(context.signal);
        progress(1);
        return {
          blob,
          provider: "local-canvas",
          model: "alpha-mask",
          width: request.width,
          height: request.height,
        };
      } finally {
        if ("close" in image && typeof image.close === "function") image.close();
      }
    },
  };
}
