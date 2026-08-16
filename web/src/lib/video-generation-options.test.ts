import { describe, expect, test } from "bun:test";
import {
  normalizeVideoRatioForProvider,
  normalizeVideoResolutionForProvider,
  normalizeVideoDurationForProvider,
  optionsWithCurrentVideoValue,
  resolveVideoDurationForProvider,
  videoSizeAfterSelectionChange,
  videoRatioOptionsFor,
  videoResolutionOptionsFor,
  videoDurationOptionsFor,
  videoSizePresetFor,
} from "@/lib/video-generation-options";

describe("video generation options", () => {
  test("uses verified provider presets and derives a matching size", () => {
    expect(videoRatioOptionsFor("apimart", "doubao-seedance-2.0").map((item) => item.value)).toContain("21:9");
    expect(videoResolutionOptionsFor("apimart", "doubao-seedance-2.0").map((item) => item.value)).toEqual(["480p", "720p", "1080p"]);
    expect(videoSizePresetFor("16:9", "1080p")).toBe("1920x1080");
    expect(videoSizePresetFor("9:16", "720p")).toBe("720x1280");
    expect(videoSizePresetFor("3:2", "720p")).toBe("1080x720");
    expect(videoSizePresetFor("2:1", "720p")).toBe("auto");
  });

  test("offers bounded duration choices for Grok and Seedance 2.0", () => {
    expect(videoDurationOptionsFor("openai", "grok-imagine-video")).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(videoDurationOptionsFor("apimart", "doubao-seedance-2.0")).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 4),
    );
    expect(normalizeVideoDurationForProvider(2, "apimart", "doubao-seedance-2.0")).toBe(4);
    expect(normalizeVideoDurationForProvider(20, "openai", "grok-imagine-video-1.5")).toBe(15);
    expect(resolveVideoDurationForProvider(false, 2, "apimart", "doubao-seedance-2.0")).toBe(4);
    expect(resolveVideoDurationForProvider(true, 8, "openai", "grok-imagine-video")).toBe(8);
    expect(resolveVideoDurationForProvider(true, 8, "template", "custom-video")).toBeUndefined();
  });

  test("fails closed for known invalid values but preserves unknown provider values", () => {
    expect(normalizeVideoRatioForProvider("21:9", "apimart", "kling-v3")).toBe("16:9");
    expect(normalizeVideoResolutionForProvider("4k", "apimart", "doubao-seedance-2.0-mini")).toBe("480p");
    expect(normalizeVideoRatioForProvider("custom-ratio", "template", "custom-video")).toBe("custom-ratio");
    expect(normalizeVideoResolutionForProvider("custom-resolution", "template", "custom-video")).toBe("custom-resolution");
  });

  test("keeps a legacy custom value visible when the model changes", () => {
    const options = optionsWithCurrentVideoValue(videoRatioOptionsFor("apimart", "kling-v3"), "legacy");
    expect(options[0]).toEqual({ value: "legacy", label: "当前自定义：legacy" });
  });

  test("updates automatic size but preserves an explicit node override", () => {
    expect(videoSizeAfterSelectionChange(
      "openai", "1280x720", "16:9", "720p", "9:16", "720p",
    )).toBe("720x1280");
    expect(videoSizeAfterSelectionChange(
      "openai", "custom-size", "16:9", "720p", "9:16", "720p",
    )).toBe("custom-size");
  });
});
