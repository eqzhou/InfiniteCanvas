import { afterEach, describe, expect, test } from "bun:test";
import { createLocalCanvasTransformProvider } from "./providers/local-canvas";

const originalBitmap = globalThis.createImageBitmap;
const originalDocument = globalThis.document;

afterEach(() => {
  globalThis.createImageBitmap = originalBitmap;
  globalThis.document = originalDocument;
});

function installCanvas(alpha = 255) {
  const pixels = new Uint8ClampedArray(16).fill(alpha);
  const drawing = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    drawImage: () => undefined,
    getImageData: () => ({ data: pixels }),
    putImageData: () => undefined,
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => drawing,
    toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["png"], { type: "image/png" })),
  };
  globalThis.document = { createElement: () => canvas } as unknown as Document;
  return { canvas, pixels };
}

describe("local canvas image transforms", () => {
  test("upscales with progress and closes the decoded bitmap", async () => {
    let closed = false;
    globalThis.createImageBitmap = async () => ({ close: () => { closed = true; } }) as ImageBitmap;
    const { canvas } = installCanvas();
    const progress: number[] = [];
    const provider = createLocalCanvasTransformProvider();

    const result = await provider.upscale!({
      image: new Blob(["image"], { type: "image/png" }),
      width: 2,
      height: 3,
      scale: 2,
    }, { signal: new AbortController().signal, onProgress: (value) => progress.push(value) });

    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 4, height: 6 });
    expect(result).toMatchObject({ provider: "local-canvas", model: "browser-bicubic", width: 4, height: 6 });
    expect(progress).toEqual([0, 0.3, 0.75, 1]);
    expect(closed).toBe(true);
  });

  test("applies a rectangular alpha mask and validates cancellation", async () => {
    globalThis.createImageBitmap = async () => ({ close: () => undefined }) as ImageBitmap;
    const { pixels } = installCanvas();
    const provider = createLocalCanvasTransformProvider();
    const result = await provider.mask!({
      image: new Blob(["image"], { type: "image/png" }),
      width: 2,
      height: 2,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      mode: "keep",
    }, { signal: new AbortController().signal });

    expect(result).toMatchObject({ model: "alpha-mask", width: 2, height: 2 });
    expect(pixels[3]).toBe(255);
    expect(pixels[7]).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(provider.upscale!({ image: new Blob(["x"], { type: "image/png" }), width: 1, height: 1, scale: 2 }, {
      signal: controller.signal,
    })).rejects.toThrow();
  });
});
