import { describe, expect, test } from "bun:test";
import {
  normalizeVideoRatioForProvider,
  normalizeVideoResolutionForProvider,
  optionsWithCurrentVideoValue,
  videoSizeAfterSelectionChange,
  videoRatioOptionsFor,
  videoResolutionOptionsFor,
  videoSizePresetFor,
} from "@/lib/video-generation-options";

describe("video generation options", () => {
  test("uses verified provider presets and derives a matching size", () => {
    expect(videoRatioOptionsFor("apimart", "doubao-seedance-2.0").map((item) => item.value)).toContain("21:9");
    expect(videoResolutionOptionsFor("apimart", "doubao-seedance-2.0").map((item) => item.value)).toContain("4k");
    expect(videoSizePresetFor("16:9", "1080p")).toBe("1920x1080");
    expect(videoSizePresetFor("9:16", "720p")).toBe("720x1280");
    expect(videoSizePresetFor("2:1", "720p")).toBe("auto");
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
