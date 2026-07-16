import { describe, expect, test } from "bun:test";

import {
  createGestureState,
  reduceGesture,
  type GestureOptions,
  type GestureState,
} from "./gesture";

const down = (state: GestureState, pointerId: number, x: number, y: number) =>
  reduceGesture(state, { type: "pointerdown", pointerId, point: { x, y } });

const move = (
  state: GestureState,
  pointerId: number,
  x: number,
  y: number,
  options?: GestureOptions,
) => reduceGesture(state, { type: "pointermove", pointerId, point: { x, y } }, options);

describe("gesture state machine", () => {
  test("a single pointer pans incrementally without mutating prior states", () => {
    const idle = createGestureState({ x: 10, y: 20, k: 2 });
    const pressed = down(idle, 7, 100, 80);
    const moved = move(pressed, 7, 130, 65);

    expect(moved.viewport).toEqual({ x: 40, y: 5, k: 2 });
    expect(idle).toEqual({
      viewport: { x: 10, y: 20, k: 2 },
      pointers: [],
      gesture: { kind: "idle" },
    });
    expect(pressed.pointers).toEqual([{ pointerId: 7, point: { x: 100, y: 80 } }]);
  });

  test("pinch keeps the world point beneath the moving center anchored", () => {
    let state = createGestureState({ x: 20, y: 40, k: 1 });
    state = down(state, 1, 100, 100);
    state = down(state, 2, 200, 100);

    state = move(state, 1, 75, 120);
    state = move(state, 2, 225, 120);

    expect(state.viewport.k).toBeCloseTo(1.5);
    expect(state.viewport.x).toBeCloseTo(-45);
    expect(state.viewport.y).toBeCloseTo(30);

    const center = { x: 150, y: 120 };
    expect((center.x - state.viewport.x) / state.viewport.k).toBeCloseTo(130);
    expect((center.y - state.viewport.y) / state.viewport.k).toBeCloseTo(60);
  });

  test("pinch zoom respects scale limits while preserving its center anchor", () => {
    let state = createGestureState({ x: 0, y: 0, k: 1 });
    state = down(state, 1, 0, 0);
    state = down(state, 2, 100, 0);
    state = move(state, 2, 1000, 0, { minScale: 0.5, maxScale: 2 });

    expect(state.viewport).toEqual({ x: 400, y: 0, k: 2 });
  });

  test("pointer cancel removes the contact and remaining pointer resumes pan without a jump", () => {
    let state = createGestureState({ x: 0, y: 0, k: 1 });
    state = down(state, 11, 0, 0);
    state = down(state, 22, 100, 0);
    state = move(state, 22, 120, 0);
    const beforeCancel = state.viewport;

    state = reduceGesture(state, { type: "pointercancel", pointerId: 22 });
    expect(state.viewport).toEqual(beforeCancel);
    expect(state.gesture).toEqual({ kind: "pan", pointerId: 11, last: { x: 0, y: 0 } });

    state = move(state, 11, 10, 15);
    expect(state.viewport).toEqual({
      x: beforeCancel.x + 10,
      y: beforeCancel.y + 15,
      k: beforeCancel.k,
    });
  });

  test("unknown moves and cancellations leave state identity unchanged", () => {
    const state = createGestureState({ x: 0, y: 0, k: 1 });

    expect(move(state, 99, 1, 1)).toBe(state);
    expect(reduceGesture(state, { type: "pointercancel", pointerId: 99 })).toBe(state);
  });
});
