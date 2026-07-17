import { describe, expect, test } from "bun:test";
import {
  assertResolvedImageReferences,
  createImageGenerationMetadata,
} from "./image-generation";

describe("image generation lineage", () => {
  test("captures a reproducible immutable generation request", () => {
    const referenceStorageKeys = ["image:one", "image:two"];
    const metadata = createImageGenerationMetadata({
      prompt: "red studio product",
      model: "image-model",
      size: "1024x1024",
      quality: "high",
      count: 3,
      transparentBackground: true,
      referenceStorageKeys,
    });

    expect(metadata).toEqual({
      prompt: "red studio product",
      model: "image-model",
      size: "1024x1024",
      quality: "high",
      count: 3,
      transparentBackground: true,
      generationType: "image-to-image",
      referenceStorageKeys: ["image:one", "image:two"],
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

  test("rejects a retry when any recorded reference cannot be restored", () => {
    expect(() => assertResolvedImageReferences(["image:one"], [])).toThrow("参考图已丢失");
    expect(() => assertResolvedImageReferences(["image:one"], ["data:image/png;base64,AA=="]))
      .not.toThrow();
  });
});
