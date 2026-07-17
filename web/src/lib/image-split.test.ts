import { describe, expect, test } from "bun:test";

import { normalizeSplitGuides, splitSegments } from "./image-split";

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
});
