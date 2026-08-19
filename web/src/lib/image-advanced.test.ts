import { afterEach, describe, expect, test } from "bun:test";
import type { BoardNode } from "@/types/board";
import { applyRectMask, splitImageByGuides, splitImageGrid, upscaleImage } from "./image-advanced";

const originalImage = globalThis.Image;

afterEach(() => {
  globalThis.Image = originalImage;
});

const emptyImage = {
  id: "image-empty",
  type: "image",
  title: "Empty",
  position: { x: 0, y: 0 },
  width: 320,
  height: 240,
  metadata: {},
} as BoardNode;

describe("advanced image operation boundaries", () => {
  test("rejects both split entry points when source media is absent", async () => {
    await expect(splitImageGrid(emptyImage, 2, 2)).rejects.toThrow("无图片");
    await expect(splitImageByGuides(emptyImage, [0.5], [0.5])).rejects.toThrow("无图片");
  });

  test("surfaces browser image decode failures for upscale and masks", async () => {
    class FailingImage {
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    globalThis.Image = FailingImage as unknown as typeof Image;

    await expect(upscaleImage("blob:bad", 2)).rejects.toThrow("图片加载失败");
    await expect(applyRectMask("blob:bad", { x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow("图片加载失败");
  });
});
