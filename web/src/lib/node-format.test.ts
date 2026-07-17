import { describe, expect, test } from "bun:test";

import { adjustFontSize, normalizeNodeTitle } from "./node-format";

describe("node formatting", () => {
  test("clamps font size to the supported 10-72px range", () => {
    expect(adjustFontSize(undefined, -2)).toBe(12);
    expect(adjustFontSize(10, -2)).toBe(10);
    expect(adjustFontSize(71, 2)).toBe(72);
  });

  test("normalizes editable titles without exceeding 500 characters", () => {
    expect(normalizeNodeTitle("  Draft title  ")).toBe("Draft title");
    expect(normalizeNodeTitle("x".repeat(600))).toHaveLength(500);
  });
});
