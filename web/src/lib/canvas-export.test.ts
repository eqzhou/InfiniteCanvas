import { describe, expect, test } from "bun:test";
import { canvasExportFilename, shouldIncludeCanvasExportNode } from "@/lib/canvas-export";

describe("canvas export helpers", () => {
  test("creates a safe timestamped PNG filename", () => {
    expect(canvasExportFilename("我的/画布", new Date("2026-08-05T03:04:05Z")))
      .toBe("我的_画布-20260805-030405.png");
  });

  test("omits transient canvas controls from the exported image", () => {
    const control = {
      hasAttribute: (name: string) => name === "data-canvas-control",
    } as unknown as Element;
    const node = {
      hasAttribute: () => false,
    } as unknown as Element;

    expect(shouldIncludeCanvasExportNode(control)).toBe(false);
    expect(shouldIncludeCanvasExportNode(node)).toBe(true);
  });

  test("keeps non-element nodes in the exported image", () => {
    const textNode = { nodeType: 3 } as unknown as Node;

    expect(shouldIncludeCanvasExportNode(textNode)).toBe(true);
  });
});
