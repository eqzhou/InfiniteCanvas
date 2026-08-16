import { describe, expect, test } from "bun:test";
import {
  IMAGE_QUALITY_OPTIONS,
  IMAGE_SIZE_OPTIONS,
  imageAspectOptionsFor,
  imageOutputLimitFor,
  imageQualityOptionsFor,
  normalizeImageAspectForProvider,
  normalizeImageSizeForProvider,
  imageSizeOptionsFor,
  normalizeImageQualityForProvider,
  optionsWithCurrentValue,
} from "./image-generation-options";

describe("image generation setting options", () => {
  test("offers common square, landscape, portrait, 4:3 and 16:9 sizes", () => {
    expect(IMAGE_SIZE_OPTIONS.map((option) => option.value)).toEqual([
      "1024x1024",
      "1536x1024",
      "1024x1536",
      "1024x768",
      "768x1024",
      "1536x864",
      "864x1536",
      "1792x768",
      "1280x1024",
      "1024x1280",
    ]);
    expect(IMAGE_SIZE_OPTIONS.find((option) => option.value === "1024x768")?.label).toContain("4:3");
    expect(IMAGE_SIZE_OPTIONS.find((option) => option.value === "864x1536")?.label).toContain("9:16");
  });

  test("offers only the supported quality presets", () => {
    expect(IMAGE_QUALITY_OPTIONS.map((option) => option.value))
      .toEqual(["auto", "low", "medium", "high"]);
    expect(imageQualityOptionsFor("openai", "grok-imagine-image-2.0").map((option) => option.value))
      .toEqual(["low", "medium", "high"]);
    expect(normalizeImageQualityForProvider("auto", "openai", "grok-imagine-image-2.0"))
      .toBe("medium");
  });

  test("uses resolution presets for APIMart current image models", () => {
    expect(imageQualityOptionsFor("apimart", "doubao-seedream-5-0-pro").map((option) => option.value))
      .toEqual(["auto", "1K", "2K"]);
    expect(normalizeImageQualityForProvider("high", "apimart", "doubao-seedream-5-0-pro")).toBe("auto");
    expect(normalizeImageQualityForProvider("2K", "apimart", "doubao-seedream-5-0-pro")).toBe("2K");
    expect(imageOutputLimitFor("apimart", "doubao-seedream-5-0-pro")).toBe(1);
    expect(imageOutputLimitFor("apimart", "nano-banana-2-lite")).toBe(4);
  });

  test("filters dimensions and aspect ratios by known provider capability", () => {
    for (const model of ["gpt-image-1", "gpt-image-1.5", "gpt-image-2"]) {
      expect(imageSizeOptionsFor("openai", model).map((option) => option.value))
        .toEqual(["1024x1024", "1536x1024", "1024x1536"]);
    }
    expect(imageSizeOptionsFor("apimart", "gpt-image-1-official").map((option) => option.value))
      .toEqual(["1024x1024", "1536x1024", "1024x1536"]);
    expect(imageAspectOptionsFor("apimart", "gpt-image-1-official").map((option) => option.aspect))
      .toEqual(["1:1", "3:2", "2:3"]);
    expect(normalizeImageAspectForProvider("4:3", "apimart", "gpt-image-1-official")).toBe("1:1");
    expect(normalizeImageAspectForProvider("3:2", "apimart", "gpt-image-1-official")).toBe("3:2");
    expect(normalizeImageAspectForProvider("4:3", "openai", "custom-image")).toBe("4:3");
    expect(imageSizeOptionsFor("apimart", "doubao-seedream-5-0-pro").map((option) => option.value))
      .toEqual(["auto", "1024x1024", "1536x1024", "1024x1536", "1024x768", "768x1024", "1536x864", "864x1536", "1792x768"]);
    expect(imageSizeOptionsFor("apimart", "nano-banana-2-lite").map((option) => option.value))
      .toContain("auto");
    expect(imageSizeOptionsFor("apimart", "nano-banana-2-lite").map((option) => option.value))
      .toContain("1024x1280");
    expect(imageSizeOptionsFor("openai", "custom-image")).toBe(IMAGE_SIZE_OPTIONS);
    expect(normalizeImageSizeForProvider("3:2")).toBe("1536x1024");
    expect(normalizeImageSizeForProvider("2048x1024")).toBe("2048x1024");
  });

  test("keeps a legacy custom value without mutating the preset list", () => {
    const original = structuredClone(IMAGE_SIZE_OPTIONS);
    const options = optionsWithCurrentValue(IMAGE_SIZE_OPTIONS, "2048x2048");

    expect(options[0]).toEqual({ value: "2048x2048", label: "当前自定义：2048x2048" });
    expect(IMAGE_SIZE_OPTIONS).toEqual(original);
    expect(optionsWithCurrentValue(IMAGE_SIZE_OPTIONS, "1024x1024")).toBe(IMAGE_SIZE_OPTIONS);
  });

  test("exposes immutable preset arrays and option records", () => {
    expect(Object.isFrozen(IMAGE_SIZE_OPTIONS)).toBe(true);
    expect(IMAGE_SIZE_OPTIONS.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(IMAGE_QUALITY_OPTIONS)).toBe(true);
    expect(IMAGE_QUALITY_OPTIONS.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(imageAspectOptionsFor("apimart", "gpt-image-1-official"))).toBe(true);
    expect(Object.isFrozen(optionsWithCurrentValue(IMAGE_SIZE_OPTIONS, "2048x2048"))).toBe(true);
  });
});
