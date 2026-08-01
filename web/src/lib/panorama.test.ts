import { describe, expect, test } from "bun:test";

import {
  buildPanoramaPrompt,
  chooseLocalTwoToOneImageImportMode,
  isStrictTwoToOnePanoramaCandidate,
  panoramaGenerationError,
  readPanoramaBlobDimensions,
  resolveLocalTwoToOneImageImportChoice,
  validatePanoramaBlob,
  validatePanoramaDimensions,
} from "./panorama";

describe("native panorama behavior", () => {
  test("accepts practical 2:1 equirectangular dimensions", () => {
    expect(validatePanoramaDimensions(2048, 1024)).toEqual({ width: 2048, height: 1024 });
    expect(validatePanoramaDimensions(4000, 2001)).toEqual({ width: 4000, height: 2001 });
  });

  test("rejects unsafe, tiny, excessive, and non-2:1 dimensions", () => {
    for (const dimensions of [
      [0, 0],
      [63, 32],
      [20_000, 10_000],
      [10_000, 5_000],
      [1920, 1080],
      [1024, 1024],
    ] as const) {
      expect(() => validatePanoramaDimensions(...dimensions)).toThrow();
    }
  });

  test("builds a stable generation instruction without mutating user text", () => {
    const prompt = "夜晚的未来城市天台";
    const result = buildPanoramaPrompt(prompt);
    expect(result).toContain(prompt);
    expect(result).toContain("360°");
    expect(result).toContain("2:1");
    expect(prompt).toBe("夜晚的未来城市天台");
  });

  test("accepts matching image signatures and rejects disguised media", async () => {
    await expect(validatePanoramaBlob(new Blob([
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    ], { type: "image/png" }))).resolves.toBeUndefined();
    await expect(validatePanoramaBlob(new Blob(["not a png"], { type: "image/png" })))
      .rejects.toThrow("声明格式");
    await expect(validatePanoramaBlob(new Blob(["GIF89a"], { type: "image/gif" })))
      .rejects.toThrow("仅支持");
  });

  test("reads and bounds panorama dimensions from headers before browser decoding", async () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    png.set([0, 0, 0, 128], 16);
    png.set([0, 0, 0, 64], 20);
    await expect(readPanoramaBlobDimensions(new Blob([png], { type: "image/png" })))
      .resolves.toEqual({ width: 128, height: 64 });
    png.set([0, 1, 0, 0], 16);
    png.set([0, 0, 0, 1], 20);
    await expect(readPanoramaBlobDimensions(new Blob([png], { type: "image/png" })))
      .rejects.toThrow(/尺寸/);
  });

  test("keeps provider response bodies out of persisted panorama errors", () => {
    expect(panoramaGenerationError(new Error("HTTP 503: internal trace and provider response")))
      .toBe("全景图生成失败（HTTP 503），请检查模型渠道设置");
    expect(panoramaGenerationError(new Error("secret upstream diagnostic")))
      .toBe("全景图生成失败，请检查模型渠道设置");
  });

  test("keeps actionable batch and reference failures while hiding unknown diagnostics", () => {
    expect(panoramaGenerationError(new Error("生成服务应返回 3 张全景图片，实际返回 2 张")))
      .toBe("生成服务应返回 3 张全景图片，实际返回 2 张");
    expect(panoramaGenerationError(new Error("有参考图片已丢失，请重新连接后再生成")))
      .toBe("有参考图片已丢失，请重新连接后再生成");
  });

  test("preserves safe server image task errors", () => {
    const message = "模型服务拒绝了图片请求（HTTP 400），请检查模型、尺寸和参数";
    expect(panoramaGenerationError(new Error(message))).toBe(message);
  });

  test("classifies only strict 2:1 JPEG/PNG/WebP as import candidates", () => {
    expect(isStrictTwoToOnePanoramaCandidate("image/png", 2048, 1024)).toBe(true);
    expect(isStrictTwoToOnePanoramaCandidate("image/jpeg", 4000, 2000)).toBe(true);
    expect(isStrictTwoToOnePanoramaCandidate("image/webp", 128, 64)).toBe(true);
    expect(isStrictTwoToOnePanoramaCandidate("image/gif", 2048, 1024)).toBe(false);
    expect(isStrictTwoToOnePanoramaCandidate("image/png", 1920, 1080)).toBe(false);
    expect(isStrictTwoToOnePanoramaCandidate(undefined, 2048, 1024)).toBe(false);
  });

  test("maps 2:1 import choice to panorama or ordinary image without cancel", () => {
    expect(resolveLocalTwoToOneImageImportChoice("panorama")).toBe("panorama");
    expect(resolveLocalTwoToOneImageImportChoice("image")).toBe("image");
    expect(resolveLocalTwoToOneImageImportChoice("cancel")).toBeNull();
    expect(resolveLocalTwoToOneImageImportChoice(undefined)).toBeNull();
    expect(chooseLocalTwoToOneImageImportMode(() => true)).toBe("panorama");
    expect(chooseLocalTwoToOneImageImportMode(() => false)).toBe("image");
  });
});
