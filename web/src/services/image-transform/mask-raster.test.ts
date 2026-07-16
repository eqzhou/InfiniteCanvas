import { describe, expect, test } from "bun:test";
import { rasterizeRectEditMask, validateNormalizedRect } from "./mask-raster";

describe("rect edit mask", () => {
  test("uses transparent pixels for the edit region and opaque pixels elsewhere", () => {
    const pixels = rasterizeRectEditMask(4, 3, { x: 0.25, y: 0, w: 0.5, h: 2 / 3 });
    const alpha = Array.from({ length: 12 }, (_, index) => pixels[index * 4 + 3]);
    expect(alpha).toEqual([
      255, 0, 0, 255,
      255, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    expect(Array.from(pixels.slice(0, 3))).toEqual([255, 255, 255]);
  });

  test("rejects non-normalized or empty rectangles and unsafe dimensions", () => {
    expect(() => validateNormalizedRect({ x: -0.1, y: 0, w: 1, h: 1 })).toThrow("normalized");
    expect(() => validateNormalizedRect({ x: 0.8, y: 0, w: 0.3, h: 1 })).toThrow("bounds");
    expect(() => rasterizeRectEditMask(0, 2, { x: 0, y: 0, w: 1, h: 1 })).toThrow("dimensions");
    expect(() => rasterizeRectEditMask(20_000, 20_000, { x: 0, y: 0, w: 1, h: 1 })).toThrow("pixel limit");
  });
});
