import { describe, expect, test } from "bun:test";
import { NODE_RESIZE_CORNERS, NODE_MIN_HEIGHT, NODE_MIN_WIDTH, resizeFromCorner } from "./node-resize";

const origin = { x: 100, y: 100, width: 200, height: 100 };

describe("corner resize geometry", () => {
  test("exposes all four corners", () => {
    expect([...NODE_RESIZE_CORNERS]).toEqual(["nw", "ne", "sw", "se"]);
  });

  test("grows away from the anchored opposite corner", () => {
    // Dragging the south-east corner keeps the north-west corner pinned.
    expect(resizeFromCorner(origin, "se", { x: 40, y: 20 }, true))
      .toEqual({ x: 100, y: 100, width: 240, height: 120 });
    // Dragging the north-west corner keeps the south-east corner pinned.
    expect(resizeFromCorner(origin, "nw", { x: -40, y: -20 }, true))
      .toEqual({ x: 60, y: 80, width: 240, height: 120 });
    expect(resizeFromCorner(origin, "ne", { x: 40, y: -20 }, true))
      .toEqual({ x: 100, y: 80, width: 240, height: 120 });
    expect(resizeFromCorner(origin, "sw", { x: -40, y: 20 }, true))
      .toEqual({ x: 60, y: 100, width: 240, height: 120 });
  });

  test("locks the aspect ratio when free resize is off", () => {
    const locked = resizeFromCorner(origin, "se", { x: 100, y: 5 }, false);
    expect(locked.width / locked.height).toBeCloseTo(origin.width / origin.height, 5);
    // The anchored corner still does not move.
    expect(locked.x).toBe(100);
    expect(locked.y).toBe(100);

    // Ratio locking must also keep the opposite corner pinned when dragging nw.
    const lockedNW = resizeFromCorner(origin, "nw", { x: -100, y: -5 }, false);
    expect(lockedNW.x + lockedNW.width).toBeCloseTo(origin.x + origin.width, 5);
    expect(lockedNW.y + lockedNW.height).toBeCloseTo(origin.y + origin.height, 5);
  });

  test("clamps to the minimum size without dragging the anchor past it", () => {
    const clamped = resizeFromCorner(origin, "nw", { x: 5_000, y: 5_000 }, true);
    expect(clamped.width).toBe(NODE_MIN_WIDTH);
    expect(clamped.height).toBe(NODE_MIN_HEIGHT);
    // The south-east corner stays pinned even while clamping.
    expect(clamped.x + clamped.width).toBe(origin.x + origin.width);
    expect(clamped.y + clamped.height).toBe(origin.y + origin.height);
  });

  test("keeps the locked ratio while clamping to the minimum size", () => {
    // Clamping each axis independently would break the ratio the user locked.
    const wide = { x: 0, y: 0, width: 400, height: 100 };
    const shrunk = resizeFromCorner(wide, "se", { x: -380, y: -5 }, false);
    expect(shrunk.width / shrunk.height).toBeCloseTo(wide.width / wide.height, 5);
    expect(shrunk.width).toBeGreaterThanOrEqual(NODE_MIN_WIDTH);
    expect(shrunk.height).toBeGreaterThanOrEqual(NODE_MIN_HEIGHT);
    // The anchored corner still holds.
    expect(shrunk.x).toBe(wide.x);
    expect(shrunk.y).toBe(wide.y);

    // A tall node clamps on height instead, and the anchor still holds.
    const tall = { x: 200, y: 200, width: 100, height: 400 };
    const shrunkTall = resizeFromCorner(tall, "nw", { x: 5_000, y: 5_000 }, false);
    expect(shrunkTall.width / shrunkTall.height).toBeCloseTo(tall.width / tall.height, 5);
    expect(shrunkTall.width).toBeGreaterThanOrEqual(NODE_MIN_WIDTH);
    expect(shrunkTall.height).toBeGreaterThanOrEqual(NODE_MIN_HEIGHT);
    expect(shrunkTall.x + shrunkTall.width).toBeCloseTo(tall.x + tall.width, 5);
    expect(shrunkTall.y + shrunkTall.height).toBeCloseTo(tall.y + tall.height, 5);
  });

  test("ignores a non-finite pointer delta instead of producing NaN geometry", () => {
    const result = resizeFromCorner(origin, "se", { x: Number.NaN, y: 10 }, true);
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.height)).toBe(true);
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
  });

  test("never mutates the origin rectangle", () => {
    const snapshot = { ...origin };
    resizeFromCorner(origin, "se", { x: 10, y: 10 }, true);
    expect(origin).toEqual(snapshot);
  });
});
