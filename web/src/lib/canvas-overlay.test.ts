import { describe, expect, test } from "bun:test";

import { isModalDialogOpen } from "./canvas-overlay";
import { viewportsEqual } from "./geometry";

describe("canvas overlay guards", () => {
  test("detects an open modal dialog and ignores other chrome", () => {
    const nodes = [
      { matches: (selector: string) => selector === '[role="dialog"]' },
      { matches: (selector: string) => selector === '[role="dialog"][aria-modal="false"]' },
    ];
    const root = {
      querySelector(selector: string) {
        return nodes.find((node) => node.matches(selector)) ?? null;
      },
    };
    expect(isModalDialogOpen(root)).toBe(false);
    nodes.push({ matches: (selector: string) => selector === '[role="dialog"][aria-modal="true"]' });
    expect(isModalDialogOpen(root)).toBe(true);
  });

  test("compares board viewports by camera position and zoom", () => {
    expect(viewportsEqual({ x: 10, y: 20, k: 1.5 }, { x: 10, y: 20, k: 1.5 })).toBe(true);
    expect(viewportsEqual({ x: 10, y: 20, k: 1.5 }, { x: 10, y: 20, k: 0.15 })).toBe(false);
  });
});
