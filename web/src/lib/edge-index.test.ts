import { describe, expect, test } from "bun:test";

import { createEdgeGeometryIndex, createEdgeIndex } from "./edge-index";
import type { BoardEdge, BoardNode } from "@/types/board";

const edge = (id: string, from: string, to: string): BoardEdge => ({ id, from, to });
const node = (id: string, x: number, y: number): BoardNode => ({
  id,
  type: "text",
  title: id,
  position: { x, y },
  width: 100,
  height: 100,
  metadata: {},
});

describe("edge index", () => {
  test("returns edges touching visible nodes in original order", () => {
    const index = createEdgeIndex([
      edge("a", "one", "two"),
      edge("b", "three", "four"),
      edge("c", "two", "three"),
    ]);
    expect(index.touching(new Set(["two"])).map((item) => item.id)).toEqual(["a", "c"]);
  });

  test("deduplicates edges when both endpoints are visible", () => {
    const index = createEdgeIndex([edge("a", "one", "two")]);
    expect(index.touching(new Set(["one", "two"]))).toEqual([edge("a", "one", "two")]);
  });

  test("returns no edges for an empty visible set", () => {
    const index = createEdgeIndex([edge("a", "one", "two")]);
    expect(index.touching(new Set())).toEqual([]);
  });
});

describe("edge geometry index", () => {
  test("keeps a long edge whose endpoints are offscreen but curve crosses the viewport", () => {
    const nodes = [node("left", -1_000, 0), node("right", 1_000, 0)];
    const index = createEdgeGeometryIndex(
      [edge("crossing", "left", "right")],
      new Map(nodes.map((item) => [item.id, item])),
    );
    expect(index.intersecting({ x: -100, y: 0, w: 200, h: 200 }).map((item) => item.id))
      .toEqual(["crossing"]);
  });

  test("excludes edge bounds outside the viewport and preserves order", () => {
    const nodes = [
      node("a", 0, 0),
      node("b", 200, 0),
      node("c", 2_000, 2_000),
      node("d", 2_300, 2_000),
    ];
    const index = createEdgeGeometryIndex(
      [edge("visible", "a", "b"), edge("outside", "c", "d")],
      new Map(nodes.map((item) => [item.id, item])),
    );
    expect(index.intersecting({ x: -50, y: -50, w: 500, h: 300 }).map((item) => item.id))
      .toEqual(["visible"]);
  });
});
