import { describe, expect, test } from "bun:test";
import {
  IMAGE_QUALITY_OPTIONS,
  IMAGE_SIZE_OPTIONS,
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
    ]);
    expect(IMAGE_SIZE_OPTIONS.find((option) => option.value === "1024x768")?.label).toContain("4:3");
    expect(IMAGE_SIZE_OPTIONS.find((option) => option.value === "864x1536")?.label).toContain("9:16");
  });

  test("offers only the supported quality presets", () => {
    expect(IMAGE_QUALITY_OPTIONS.map((option) => option.value))
      .toEqual(["auto", "low", "medium", "high"]);
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
  });
});
