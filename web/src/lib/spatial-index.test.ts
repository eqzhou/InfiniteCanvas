import { describe, expect, test } from "bun:test";

import { createNodeSpatialIndex } from "./spatial-index";
import type { BoardNode } from "@/types/board";

const node = (id: string, x: number, y: number, width = 100, height = 100): BoardNode => ({
  id,
  type: "text",
  title: id,
  position: { x, y },
  width,
  height,
  metadata: {},
});

describe("node spatial index", () => {
  test("returns intersecting nodes in their original stacking order", () => {
    const index = createNodeSpatialIndex([
      node("first", 450, 10, 120, 120),
      node("outside", 900, 900),
      node("second", -40, 20, 80, 80),
    ], 256);

    expect(index.query({ x: -50, y: 0, w: 650, h: 200 }).map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
  });

  test("does not duplicate nodes spanning multiple grid cells", () => {
    const index = createNodeSpatialIndex([node("wide", 0, 0, 900, 900)], 128);
    expect(index.query({ x: 200, y: 200, w: 400, h: 400 }).map((item) => item.id)).toEqual(["wide"]);
  });

  test("handles negative coordinates and very large nodes", () => {
    const index = createNodeSpatialIndex([
      node("negative", -1000, -1000, 50, 50),
      node("huge", -100_000, -100_000, 200_000, 200_000),
    ]);
    expect(index.query({ x: -980, y: -980, w: 20, h: 20 }).map((item) => item.id)).toEqual([
      "negative",
      "huge",
    ]);
  });

  test("treats touching edges as non-intersecting", () => {
    const index = createNodeSpatialIndex([node("right", 100, 0, 50, 50)]);
    expect(index.query({ x: 0, y: 0, w: 100, h: 50 })).toEqual([]);
  });
});
