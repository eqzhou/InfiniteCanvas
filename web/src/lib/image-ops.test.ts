import { describe, expect, test } from "bun:test";
import type { BoardNode } from "@/types/board";
import { makeCroppedNode, makeRotatedNode } from "./image-ops";

const emptyImage = {
  id: "image-empty",
  type: "image",
  title: "Empty",
  position: { x: 0, y: 0 },
  width: 320,
  height: 240,
  metadata: {},
} as BoardNode;

describe("derived image node guards", () => {
  test("rejects crop and rotation before storage work when source media is absent", async () => {
    await expect(makeCroppedNode(emptyImage, { x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow("无图片");
    await expect(makeRotatedNode(emptyImage, 90)).rejects.toThrow("无图片");
  });
});
