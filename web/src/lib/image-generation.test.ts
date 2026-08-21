import { describe, expect, test } from "bun:test";
import {
  assertResolvedImageReferences,
  canRetryImageResult,
  createImageGenerationMetadata,
  normalizeImageGenerationForProvider,
} from "./image-generation";

describe("image generation lineage", () => {
  test("captures a reproducible immutable generation request", () => {
    const referenceStorageKeys = ["image:one", "image:two"];
    const metadata = createImageGenerationMetadata({
      prompt: "red studio product",
      model: "image-model",
      size: "1024x1024",
      quality: "high",
      resolution: "2K",
      count: 3,
      transparentBackground: true,
      referenceStorageKeys,
      generationChannelId: "channel-one",
    });

    expect(metadata).toEqual({
      prompt: "red studio product",
      model: "image-model",
      size: "1024x1024",
      quality: "high",
      resolution: "2K",
      count: 3,
      transparentBackground: true,
      generationType: "image-to-image",
      referenceStorageKeys: ["image:one", "image:two"],
      generationChannelId: "channel-one",
    });
    expect(metadata.referenceStorageKeys).not.toBe(referenceStorageKeys);
  });

  test("marks requests without references as text-to-image", () => {
    expect(createImageGenerationMetadata({
      prompt: "poster",
      model: "image-model",
      size: "1024x1536",
      quality: "auto",
      count: 1,
      transparentBackground: false,
      referenceStorageKeys: [],
    }).generationType).toBe("text-to-image");
  });

  test("normalizes legacy image settings before a known provider request", () => {
    const source = createImageGenerationMetadata({
      prompt: "poster",
      model: "doubao-seedream-5-0-pro",
      size: "3:2",
      quality: "high",
      resolution: "2K",
      count: 8,
      transparentBackground: false,
      referenceStorageKeys: [],
    });
    const normalized = normalizeImageGenerationForProvider(source, "apimart");

    expect(normalized).toMatchObject({ size: "1536x1024", quality: "high", resolution: "2K", count: 8 });
    expect(normalized).not.toBe(source);
    expect(normalized.referenceStorageKeys).not.toBe(source.referenceStorageKeys);
  });

  test("migrates legacy resolution values stored in quality", () => {
    const source = createImageGenerationMetadata({
      prompt: "poster",
      model: "doubao-seedream-5-0-pro",
      size: "1024x1024",
      quality: "2K",
      count: 1,
      transparentBackground: false,
      referenceStorageKeys: [],
    });
    expect(source).toMatchObject({ quality: "auto", resolution: "2K" });
    expect(normalizeImageGenerationForProvider(source, "apimart")).toMatchObject({
      quality: "auto", resolution: "2K",
    });
  });

  test("rejects a retry when any recorded reference cannot be restored", () => {
    expect(() => assertResolvedImageReferences(["image:one"], [])).toThrow("参考图已丢失");
    expect(() => assertResolvedImageReferences(["image:one"], ["data:image/png;base64,AA=="]))
      .not.toThrow();
  });

  test("copies structured camera metadata without aliasing the request", () => {
    const cameraPrompt = { enabled: true, camera: "cinema" as const, lens: "wide" as const, focalLength: 24, aperture: 4 };
    const metadata = createImageGenerationMetadata({
      prompt: "city", model: "image", size: "1024x1024", quality: "auto", count: 1,
      transparentBackground: false, referenceStorageKeys: [], cameraPrompt,
    });
    expect(metadata.cameraPrompt).toEqual(cameraPrompt);
    expect(metadata.cameraPrompt).not.toBe(cameraPrompt);
  });

  test("only failed leaf results expose an in-place retry", () => {
    expect(canRetryImageResult({ status: "error", prompt: "retry me" })).toBe(true);
    expect(canRetryImageResult({ status: "success", prompt: "already done" })).toBe(false);
    expect(canRetryImageResult({
      status: "error",
      prompt: "failed batch preview",
      isBatchRoot: true,
      batchChildIds: ["result-1"],
    })).toBe(false);
  });
});
