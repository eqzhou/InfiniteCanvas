import { describe, expect, test } from "bun:test";
import {
  IMAGE_ASPECT_PRESETS,
  imageAspectForSize,
  normalizePreferredModels,
  resolveImageSizeForAspect,
  resolvePreferredModel,
  withPreferredModel,
} from "@/lib/workbench-preferences";

describe("workbench preferences", () => {
  test("normalizes channel and generation-kind model preferences", () => {
    expect(normalizePreferredModels({
      "channel-a": { image: " image-v2 ", video: "video-v1", unknown: "ignored" },
      "bad channel": { image: "ignored" },
      "channel-b": { text: 42, audio: "" },
    })).toEqual({
      "channel-a": { image: "image-v2", video: "video-v1" },
    });
  });

  test("updates one channel and kind without mutating sibling preferences", () => {
    const input = {
      "channel-a": { image: "image-v1", video: "video-v1" },
      "channel-b": { image: "other-image" },
    } as const;
    const updated = withPreferredModel(input, "channel-a", "image", "image-v2");

    expect(updated).toEqual({
      "channel-a": { image: "image-v2", video: "video-v1" },
      "channel-b": { image: "other-image" },
    });
    expect(updated).not.toBe(input);
    expect(updated["channel-a"]).not.toBe(input["channel-a"]);
    expect(updated["channel-b"]).toBe(input["channel-b"]);
    expect(input["channel-a"].image).toBe("image-v1");
  });

  test("restores a preferred model and falls back when it was retired", () => {
    expect(resolvePreferredModel("image-v2", "image-v1", ["image-v1", "image-v2"]))
      .toBe("image-v2");
    expect(resolvePreferredModel("retired", "image-v1", ["image-v1", "image-v2"]))
      .toBe("image-v1");
    expect(resolvePreferredModel("retired", "also-retired", ["image-v2"]))
      .toBe("image-v2");
    // With no published model list, a hand-entered preference cannot be proven retired.
    expect(resolvePreferredModel("custom-image", "image-v1", [])).toBe("custom-image");
  });

  test("maps common aspect presets to provider-supported size representations", () => {
    expect(IMAGE_ASPECT_PRESETS.map((preset) => preset.aspect)).toEqual(["1:1", "3:2", "2:3"]);
    expect(resolveImageSizeForAspect("1:1", "openai", "gpt-image-1")).toBe("1024x1024");
    expect(resolveImageSizeForAspect("3:2", "openai", "gpt-image-1")).toBe("1536x1024");
    expect(resolveImageSizeForAspect("2:3", "openai", "gpt-image-1")).toBe("1024x1536");
    expect(resolveImageSizeForAspect("3:2", "apimart", "gpt-image-1-official")).toBe("3:2");
  });

  test("recognizes preset sizes but keeps arbitrary dimensions custom", () => {
    expect(imageAspectForSize("1536x1024")).toBe("3:2");
    expect(imageAspectForSize("2:3")).toBe("2:3");
    expect(imageAspectForSize("1200x700")).toBe("custom");
    expect(imageAspectForSize(" 1200x700 ")).toBe("custom");
  });
});
