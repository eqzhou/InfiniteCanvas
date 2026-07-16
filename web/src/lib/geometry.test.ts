import { describe, expect, test } from "bun:test";

import {
  fitMediaDisplaySize,
  fitViewport,
  nodesInViewport,
  rectsIntersect,
  screenToWorld,
  worldToScreen,
} from "./geometry";
import type { BoardNode, Viewport } from "@/types/board";

const node = (x: number, y: number, width: number, height: number): BoardNode => ({
  id: `${x}:${y}`,
  type: "text",
  title: "node",
  position: { x, y },
  width,
  height,
  metadata: {},
});

describe("canvas geometry", () => {
  test("screen and world transforms are inverse operations", () => {
    const viewport: Viewport = { x: 120, y: -40, k: 1.75 };
    const world = { x: -42, y: 96 };

    expect(screenToWorld(worldToScreen(world, viewport), viewport)).toEqual(world);
  });

  test("fitViewport centers the complete node bounds", () => {
    const viewport = fitViewport([node(-100, -50, 100, 100), node(200, 150, 200, 100)], 1000, 600, 50);
    const worldCenter = screenToWorld({ x: 500, y: 300 }, viewport);

    expect(worldCenter.x).toBeCloseTo(150);
    expect(worldCenter.y).toBeCloseTo(100);
    expect(viewport.k).toBeGreaterThanOrEqual(0.15);
    expect(viewport.k).toBeLessThanOrEqual(2);
  });

  test("fitViewport returns a usable origin for an empty board", () => {
    expect(fitViewport([], 900, 500)).toEqual({ x: 450, y: 250, k: 1 });
  });

  test("media display bounds keep tiny and huge images usable", () => {
    expect(fitMediaDisplaySize(1, 1)).toEqual({ width: 120, height: 120 });
    expect(fitMediaDisplaySize(4_000, 2_000)).toEqual({ width: 420, height: 210 });
    expect(fitMediaDisplaySize(0, Number.NaN)).toEqual({ width: 320, height: 320 });
  });

  test("touching rectangle edges do not count as an intersection", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 })).toBe(true);
  });

  test("culls nodes outside the viewport with configurable overscan", () => {
    const nodes = [
      node(10, 10, 100, 100),
      node(900, 900, 100, 100),
      node(-80, 20, 40, 40),
    ];
    const visible = nodesInViewport(nodes, { x: 0, y: 0, k: 1 }, 500, 400, 50);
    expect(visible.map((item) => item.id)).toEqual(["10:10", "-80:20"]);
  });
});
