import { describe, expect, test } from "bun:test";

import { createNode, createProject } from "./defaults";
import {
  commitPanoramaGeneration,
  getPanoramaGenerationSettings,
  getPanoramaReferenceInputs,
  loadPanoramaReferenceBlobs,
  stagePanoramaGeneratedMedia,
  type PanoramaGeneratedMedia,
} from "./panorama-generation";

const media = (index: number): PanoramaGeneratedMedia => ({
  content: `blob:panorama-${index}`,
  storageKey: `image:panorama-${index}`,
  naturalWidth: 2048,
  naturalHeight: 1024,
  bytes: 4096 + index,
  mimeType: "image/png",
});

describe("panorama generation planning", () => {
  test("accepts ordinary connected images as ordered references without requiring a 2:1 input", () => {
    const project = createProject("Panorama references");
    const square = createNode("image", { x: 0, y: 0 }, {
      id: "image_square",
      metadata: {
        content: "blob:square",
        storageKey: "image:square",
        naturalWidth: 1024,
        naturalHeight: 1024,
        bytes: 8,
        mimeType: "image/png",
      },
    });
    const wide = createNode("image", { x: 0, y: 200 }, {
      id: "image_wide",
      metadata: {
        content: "blob:wide",
        storageKey: "image:wide",
        naturalWidth: 1920,
        naturalHeight: 1080,
        bytes: 8,
        mimeType: "image/jpeg",
      },
    });
    const panorama = createNode("panorama", { x: 400, y: 0 }, {
      id: "panorama_target",
      metadata: { inputOrder: [wide.id, square.id] },
    });
    project.nodes = [square, wide, panorama];
    project.edges = [
      { id: "edge_square", from: square.id, to: panorama.id },
      { id: "edge_wide", from: wide.id, to: panorama.id },
    ];

    expect(getPanoramaReferenceInputs(project, panorama.id)).toEqual([
      { nodeId: wide.id, storageKey: wide.metadata.storageKey, bytes: 8, mimeType: "image/jpeg" },
      { nodeId: square.id, storageKey: square.metadata.storageKey, bytes: 8, mimeType: "image/png" },
    ]);
    expect(project.nodes[0]).toBe(square);
  });

  test("loads managed reference blobs within an actual-byte budget", async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
    await expect(loadPanoramaReferenceBlobs([
      { nodeId: "image_1", storageKey: "image:one", bytes: 8, mimeType: "image/png" },
    ], async () => png)).resolves.toEqual([png]);
    await expect(loadPanoramaReferenceBlobs([
      { nodeId: "image_1", storageKey: "image:one", bytes: 7, mimeType: "image/png" },
    ], async () => png)).rejects.toThrow(/丢失/);
  });

  test("normalizes fixed-size quality and result-count settings", () => {
    expect(getPanoramaGenerationSettings({ count: 3, quality: "high" }, "auto")).toEqual({
      count: 3,
      quality: "high",
      size: "2048x1024",
    });
    expect(getPanoramaGenerationSettings({}, "medium")).toEqual({
      count: 1,
      quality: "medium",
      size: "2048x1024",
    });
    expect(() => getPanoramaGenerationSettings({ count: 9 }, "auto")).toThrow(/1-8/);
    expect(() => getPanoramaGenerationSettings({ quality: "" }, "auto")).toThrow(/质量/);
  });

  test("commits a multi-result panorama batch atomically and immutably", () => {
    const project = createProject("Panorama batch");
    const panorama = createNode("panorama", { x: 100, y: 80 }, {
      id: "panorama_root",
      metadata: { prompt: "quiet forest", count: 3, quality: "high" },
    });
    project.nodes = [panorama];
    const snapshot = structuredClone(project);

    const committed = commitPanoramaGeneration(project, panorama.id, [media(0), media(1), media(2)], {
      prompt: "quiet forest",
      model: "image-model",
      quality: "high",
      referenceStorageKeys: ["image:reference"],
      generationJobId: "job-panorama",
    });

    expect(project).toEqual(snapshot);
    expect(committed.nodes).toHaveLength(3);
    const root = committed.nodes.find((node) => node.id === panorama.id)!;
    const children = committed.nodes.filter((node) => node.metadata.batchRootId === panorama.id);
    expect(root).toMatchObject({
      type: "panorama",
      metadata: {
        content: media(0).content,
        storageKey: media(0).storageKey,
        count: 3,
        quality: "high",
        isBatchRoot: true,
        primaryImageId: panorama.id,
        referenceStorageKeys: ["image:reference"],
        generationJobId: "job-panorama",
        panoramaProjection: "equirectangular",
      },
    });
    expect(root.metadata.batchChildIds).toEqual(children.map((node) => node.id));
    expect(children).toHaveLength(2);
    expect(children.every((node) => node.type === "panorama" && node.metadata.panoramaProjection === "equirectangular")).toBe(true);
    expect(children.every((node) => node.metadata.generationJobId === "job-panorama")).toBe(true);
    expect(children[0]!.position.x + children[0]!.width).toBeLessThanOrEqual(children[1]!.position.x);

    const grouped = {
      ...committed,
      nodes: [...committed.nodes, createNode("group", { x: 500, y: 80 }, {
        id: "group_old_result",
        metadata: { childIds: [children[0]!.id] },
      })],
      edges: [...committed.edges, { id: "edge_old_group", from: children[0]!.id, to: "group_old_result" }],
    };
    const replaced = commitPanoramaGeneration(grouped, panorama.id, [media(3)], {
      prompt: "replacement",
      model: "image-model",
      quality: "medium",
      referenceStorageKeys: [],
    });
    expect(replaced.nodes).toHaveLength(1);
    expect(replaced.edges).toHaveLength(0);
    expect(replaced.nodes[0]!.metadata).toMatchObject({
      content: media(3).content,
      isBatchRoot: false,
      batchChildIds: [],
      primaryImageId: undefined,
    });
  });

  test("rejects incomplete or non-panorama outputs before changing the project", () => {
    const project = createProject("Invalid panorama batch");
    const panorama = createNode("panorama", { x: 0, y: 0 }, { id: "panorama_root" });
    project.nodes = [panorama];
    expect(() => commitPanoramaGeneration(project, panorama.id, [], {
      prompt: "scene",
      model: "image-model",
      quality: "auto",
      referenceStorageKeys: [],
    })).toThrow(/1-8/);
    expect(() => commitPanoramaGeneration(project, panorama.id, [
      { ...media(0), naturalWidth: 1024, naturalHeight: 1024 },
    ], {
      prompt: "scene",
      model: "image-model",
      quality: "auto",
      referenceStorageKeys: [],
    })).toThrow(/2:1/);
    expect(project.nodes).toEqual([panorama]);
  });

  test("rejects writes to a panorama batch child", () => {
    const project = createProject("Panorama child");
    const child = createNode("panorama", { x: 0, y: 0 }, {
      id: "panorama_child",
      metadata: { batchRootId: "panorama_root" },
    });
    project.nodes = [child];
    expect(() => commitPanoramaGeneration(project, child.id, [media(0)], {
      prompt: "scene",
      model: "image-model",
      quality: "auto",
      referenceStorageKeys: [],
    })).toThrow(/子结果/);
  });

  test("rejects a batch that would exceed the complete project panorama budget", () => {
    const project = createProject("Panorama project budget");
    project.nodes = Array.from({ length: 38 }, (_, index) => createNode(
      "panorama",
      { x: index * 20, y: 0 },
      {
        id: `panorama_${index}`,
        metadata: {
          content: `blob:existing-${index}`,
          storageKey: `image:existing-${index}`,
          naturalWidth: 4096,
          naturalHeight: 1024,
          bytes: 1024,
          mimeType: "image/png",
          panoramaProjection: "equirectangular",
        },
      },
    ));
    expect(() => commitPanoramaGeneration(project, "panorama_0", Array.from(
      { length: 8 },
      (_, index) => media(index),
    ), {
      prompt: "scene",
      model: "image-model",
      quality: "auto",
      referenceStorageKeys: [],
    })).toThrow(/aggregate limits/);
  });

  test("cleans every staged blob when any generated result fails validation", async () => {
    const removed: string[] = [];
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
    await expect(stagePanoramaGeneratedMedia(
      ["first", "second"],
      2,
      async (url) => ({
        blob: png,
        url: `blob:${url}`,
        storageKey: `image:${url}`,
        width: url === "first" ? 2048 : 1024,
        height: 1024,
        bytes: 8,
        mimeType: "image/png",
      }),
      async (storageKey) => { removed.push(storageKey); },
    )).rejects.toThrow(/2:1/);
    expect(removed.sort()).toEqual(["image:first", "image:second"]);
  });

  test("rejects and cleans a batch above the aggregate pixel budget", async () => {
    const removed: string[] = [];
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
    await expect(stagePanoramaGeneratedMedia(
      ["first", "second"],
      2,
      async (url) => ({
        blob: png,
        url: `blob:${url}`,
        storageKey: `image:${url}`,
        width: 8192,
        height: 4096,
        bytes: 8,
        mimeType: "image/png",
      }),
      async (storageKey) => { removed.push(storageKey); },
    )).rejects.toThrow(/6400 万像素/);
    expect(removed.sort()).toEqual(["image:first", "image:second"]);
  });
});
