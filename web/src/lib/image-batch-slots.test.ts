import { describe, expect, test } from "bun:test";

import { canRetryImageResult } from "./image-generation";
import {
  IMAGE_BATCH_COLUMNS,
  deleteImageBatchSlot,
  duplicateImageBatchSlot,
  expandImageBatchPositions,
  imageBatchSlotActions,
} from "./image-batch-slots";
import { parseBoardProject } from "./board-document";
import { createNode } from "./defaults";
import type { BoardNode, BoardProject } from "@/types/board";

function image(id: string, extras: Partial<BoardNode["metadata"]> = {}, position = { x: 0, y: 0 }): BoardNode {
  return createNode("image", position, {
    id,
    title: id,
    metadata: { content: `blob:${id}`, storageKey: `key:${id}`, status: "success", prompt: "a cat", ...extras },
  });
}

function project(nodes: BoardNode[]): BoardProject {
  return {
    schemaVersion: 3,
    projectKind: "canvas",
    id: "p1",
    title: "board",
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
    backgroundMode: "dots",
    viewport: { x: 0, y: 0, k: 1 },
    nodes,
    edges: [],
    chatSessions: [],
    activeChatId: null,
  };
}

describe("image batch slots", () => {
  test("fans expanded results into four columns", () => {
    expect(IMAGE_BATCH_COLUMNS).toBe(4);
    const root = image("root", { isBatchRoot: true, batchChildIds: ["a", "b", "c", "d", "e"], imageBatchExpanded: true }, { x: 10, y: 20 });
    root.width = 240;
    root.height = 180;
    const positions = expandImageBatchPositions(root, ["a", "b", "c", "d", "e"]);
    expect(positions.e).toEqual({
      x: 10 + 240 + 48,
      y: 20 + Math.max(300, 180 + 48),
    });
    expect(positions.d?.x).toBe(positions.a!.x + 3 * Math.max(300, 240 + 48));
  });

  test("deletes one failed slot without touching other results", () => {
    const failed = image("fail", { content: undefined, storageKey: undefined, status: "error" });
    const board = project([
      image("root", { isBatchRoot: true, batchChildIds: ["ok", "fail"], primaryImageId: "fail" }),
      image("ok"),
      failed,
    ]);
    const next = deleteImageBatchSlot(board, "fail");
    expect(next.nodes.map((node) => node.id)).toEqual(["root", "ok"]);
    expect(next.nodes[0]?.metadata.batchChildIds).toEqual(["ok"]);
    expect(next.nodes[0]?.metadata.primaryImageId).toBe("ok");
    expect(board.nodes).toHaveLength(3);
    const emptied = deleteImageBatchSlot(next, "ok");
    expect(emptied.nodes.map((node) => node.id)).toEqual(["root"]);
    expect(emptied.nodes[0]?.metadata.isBatchRoot).toBeUndefined();
    expect(emptied.nodes[0]?.metadata.batchChildIds).toBeUndefined();
    expect(deleteImageBatchSlot(board, "root")).toBe(board);
  });

  test("deleting a grouped slot keeps the board parseable", () => {
    const board = project([
      image("root", { isBatchRoot: true, batchChildIds: ["ok", "fail"], primaryImageId: "fail" }),
      image("ok", { batchRootId: "root" }),
      image("fail", { batchRootId: "root" }),
      createNode("group", { x: 0, y: 0 }, { id: "g1", metadata: { childIds: ["ok", "fail"] } }),
    ]);
    const next = deleteImageBatchSlot(board, "fail");
    expect(next.nodes.find((node) => node.id === "g1")?.metadata.childIds).toEqual(["ok"]);
    expect(next.nodes.map((node) => node.id)).not.toContain("fail");
    expect(() => parseBoardProject(next)).not.toThrow();
  });

  test("duplicates a slot as an independent image node", () => {
    const board = project([
      image("root", { isBatchRoot: true, batchChildIds: ["ok"] }),
      image("ok", { generationJobId: "job-ok", status: "loading" }),
    ]);
    const next = duplicateImageBatchSlot(board, "ok");
    const copy = next.nodes.find((node) => node.id !== "root" && node.id !== "ok");
    expect(copy?.metadata.batchRootId).toBeUndefined();
    expect(copy?.metadata.isBatchRoot).toBeUndefined();
    expect(copy?.metadata.content).toBe("blob:ok");
    expect(copy?.metadata.generationJobId).toBeUndefined();
    expect(copy?.metadata.status).toBe("idle");
    expect(next.nodes.find((node) => node.id === "root")?.metadata.batchChildIds).toEqual(["ok"]);
  });

  test("removes edges attached to a deleted slot", () => {
    const board = project([
      image("root", { isBatchRoot: true, batchChildIds: ["ok"] }),
      image("ok"),
    ]);
    board.edges = [{ id: "e1", from: "ok", to: "root" }];
    const next = deleteImageBatchSlot(board, "ok");
    expect(next.edges).toEqual([]);
  });

  test("exposes retry only for failed non-root image slots", () => {
    const failed = image("fail", { content: undefined, storageKey: undefined, status: "error" });
    expect(canRetryImageResult(failed.metadata)).toBe(true);
    expect(imageBatchSlotActions(failed, { hasMedia: false }).retry).toBe(true);
    expect(imageBatchSlotActions(image("ok"), { hasMedia: true })).toEqual({
      retry: false,
      deleteSlot: true,
      download: true,
      duplicate: true,
    });
    const panorama = createNode("panorama", { x: 0, y: 0 }, {
      id: "pano-fail",
      metadata: { status: "error", prompt: "a hall" },
    });
    expect(imageBatchSlotActions(panorama, { hasMedia: false }).retry).toBe(false);
  });
});
