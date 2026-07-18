import { describe, expect, test } from "bun:test";
import type { BoardNode } from "@/types/board";
import { findOpenNodePosition } from "./node-placement";

const node = (id: string, x: number, y: number, width = 280, height = 180): BoardNode => ({
  id,
  type: "text",
  title: id,
  position: { x, y },
  width,
  height,
  metadata: {},
});

describe("new node placement", () => {
  test("keeps the requested position when it is open", () => {
    expect(findOpenNodePosition([], { x: 120, y: 80 }, { width: 300, height: 200 }))
      .toEqual({ x: 120, y: 80 });
  });

  test("places repeated nodes beside occupied bounds without mutating input", () => {
    const nodes = [
      node("first", 120, 80),
      node("second", 452, 80, 300, 300),
    ];
    const snapshot = structuredClone(nodes);

    expect(findOpenNodePosition(nodes, { x: 120, y: 80 }, { width: 300, height: 300 }))
      .toEqual({ x: 784, y: 80 });
    expect(nodes).toEqual(snapshot);
  });
});
