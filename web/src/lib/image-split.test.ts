import { describe, expect, test } from "bun:test";

import { buildSplitCells, normalizeSplitGuides, splitSegments } from "./image-split";

describe("adjustable image split guides", () => {
  test("sorts, clamps, deduplicates, and rounds normalized coordinates", () => {
    expect(normalizeSplitGuides([0.75, 0.2, 0.20001, 2, -1])).toEqual([0.2, 0.75]);
  });

  test("builds complete non-overlapping segments", () => {
    expect(splitSegments([0.25, 0.75])).toEqual([
      { start: 0, end: 0.25 },
      { start: 0.25, end: 0.75 },
      { start: 0.75, end: 1 },
    ]);
  });

  test("freezes exact bounded pixel geometry for every grid candidate", () => {
    expect(buildSplitCells(100, 60, [0.25, 0.75], [0.5])).toEqual([
      { index: 0, row: 0, column: 0, x: 0, y: 0, width: 25, height: 30 },
      { index: 1, row: 0, column: 1, x: 25, y: 0, width: 50, height: 30 },
      { index: 2, row: 0, column: 2, x: 75, y: 0, width: 25, height: 30 },
      { index: 3, row: 1, column: 0, x: 0, y: 30, width: 25, height: 30 },
      { index: 4, row: 1, column: 1, x: 25, y: 30, width: 50, height: 30 },
      { index: 5, row: 1, column: 2, x: 75, y: 30, width: 25, height: 30 },
    ]);
  });

  test("rejects invalid source dimensions instead of emitting synthetic crops", () => {
    expect(() => buildSplitCells(0, 60, [], [])).toThrow("dimensions");
    expect(() => buildSplitCells(100.5, 60, [], [])).toThrow("dimensions");
    expect(() => buildSplitCells(100, 100_000, [], [])).toThrow("dimensions");
  });
});
