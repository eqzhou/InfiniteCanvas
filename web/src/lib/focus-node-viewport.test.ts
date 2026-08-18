import { describe, expect, test } from "bun:test";

import { focusNodeViewport, LOCATE_NODE_MAX_ZOOM } from "./geometry";

describe("locate-node viewport", () => {
  test("centers the node without exceeding 100% zoom", () => {
    expect(LOCATE_NODE_MAX_ZOOM).toBe(1);
    const viewport = focusNodeViewport(
      { position: { x: 200, y: 80 }, width: 100, height: 40 },
      { x: 10, y: 20, k: 2 },
      800,
      600,
    );
    expect(viewport.k).toBe(1);
    expect(viewport.x).toBe(800 / 2 - 250);
    expect(viewport.y).toBe(600 / 2 - 100);
  });

  test("keeps a zoomed-out camera and only recenters", () => {
    const viewport = focusNodeViewport(
      { position: { x: 0, y: 0 }, width: 200, height: 100 },
      { x: 0, y: 0, k: 0.4 },
      1000,
      500,
    );
    expect(viewport.k).toBe(0.4);
    expect(viewport.x).toBe(1000 / 2 - 100 * 0.4);
    expect(viewport.y).toBe(500 / 2 - 50 * 0.4);
  });
});
