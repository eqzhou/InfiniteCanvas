import { describe, expect, test } from "bun:test";

import {
  exportProjectBundle,
  importProjectBundle,
  type ProjectBundleStorage,
} from "./project-bundle";
import { createZipStore, readZipStore } from "./zip-store";
import type { BoardProject } from "@/types/board";
import { createNode, createProject } from "./defaults";
import { addDirectorModel, createDefaultDirectorScene } from "./director-scene";

const pngHeader = (() => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(16, 2048, false);
  new DataView(bytes.buffer).setUint32(20, 1024, false);
  return bytes;
})();

const project = (): BoardProject => ({
  id: "project_1",
  title: "Bundle test",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
  nodes: [
    {
      id: "image_1",
      type: "image",
      title: "Image",
      position: { x: 0, y: 0 },
      width: 320,
      height: 320,
      metadata: {
        content: "blob:local-image",
        storageKey: "image:original",
        mimeType: "image/png",
      },
    },
    {
      id: "video_1",
      type: "video",
      title: "Video",
      position: { x: 400, y: 0 },
      width: 360,
      height: 240,
      metadata: {
        content: "blob:local-video",
        storageKey: "media:original",
        referenceStorageKeys: ["image:original"],
        mimeType: "video/mp4",
      },
    },
    {
      id: "panorama_1",
      type: "panorama",
      title: "Panorama",
      position: { x: 800, y: 0 },
      width: 360,
      height: 280,
      metadata: {
        content: "blob:local-panorama",
        storageKey: "image:panorama",
        mimeType: "image/png",
        naturalWidth: 2048,
        naturalHeight: 1024,
        panoramaProjection: "equirectangular",
      },
    },
  ],
  edges: [],
  chatSessions: [
    {
      id: "chat_1",
      title: "Chat",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      messages: [
        {
          id: "message_1",
          role: "assistant",
          mode: "image",
          text: "result",
          images: [{ id: "result_1", url: "blob:same-image", storageKey: "image:original" }],
        },
      ],
    },
  ],
  activeChatId: "chat_1",
  backgroundMode: "dots",
  viewport: { x: 0, y: 0, k: 1 },
});

function memoryStorage(blobs: Map<string, Blob>) {
  const removed: string[] = [];
  let sequence = 0;
  const storage: ProjectBundleStorage = {
    load: async (_kind, key) => blobs.get(key),
    store: async (kind, blob) => {
      sequence += 1;
      const storageKey = `${kind}:imported-${sequence}`;
      blobs.set(storageKey, blob);
      return {
        storageKey,
        url: `blob:imported-${sequence}`,
        width: kind === "image" ? 2048 : 0,
        height: kind === "image" ? 1024 : 0,
        bytes: blob.size,
        mimeType: blob.type,
      };
    },
    remove: async (_kind, key) => {
      removed.push(key);
      blobs.delete(key);
    },
  };
  return { storage, removed };
}

describe("project media bundle", () => {
  test("round trips and deduplicates media while remapping every reference", async () => {
    const blobs = new Map<string, Blob>([
      ["image:original", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })],
      ["media:original", new Blob([new Uint8Array([4, 5])], { type: "video/mp4" })],
      ["image:panorama", new Blob([pngHeader], { type: "image/png" })],
    ]);
    const { storage } = memoryStorage(blobs);

    const archive = await exportProjectBundle(project(), storage);
    const entries = await readZipStore(archive);
    expect([...entries.keys()].sort()).toEqual([
      "manifest.json",
      "objects/media-1.bin",
      "objects/media-2.bin",
      "objects/media-3.bin",
      "project.json",
    ]);

    const restored = await importProjectBundle(archive, storage);
    expect(restored.nodes[0]?.metadata.storageKey).toBe("image:imported-1");
    expect(restored.nodes[0]?.metadata.content).toBe("blob:imported-1");
    expect(restored.chatSessions[0]?.messages[0]?.images?.[0]?.storageKey).toBe(
      "image:imported-1",
    );
    expect(restored.nodes[1]?.metadata.storageKey).toBe("media:imported-2");
    expect(restored.nodes[1]?.metadata.referenceStorageKeys).toEqual(["image:imported-1"]);
    expect(restored.nodes[2]?.metadata.storageKey).toBe("image:imported-3");
    expect(restored.nodes[2]?.metadata.content).toBe("blob:imported-3");
    expect(restored.nodes[2]?.metadata.panoramaProjection).toBe("equirectangular");
  });

  test("refuses export when a referenced blob is missing", async () => {
    const { storage } = memoryStorage(new Map());
    await expect(exportProjectBundle(project(), storage)).rejects.toThrow("missing");
  });

  test("keeps browser-local GLB bytes out of a project bundle while preserving its descriptor", async () => {
    const local = createProject("Local model");
    const scene = addDirectorModel(createDefaultDirectorScene(), {
      assetId: "model_asset_1",
      fileName: "hero.glb",
      bytes: 2048,
    }, "model_1");
    local.nodes = [createNode("director", { x: 0, y: 0 }, { metadata: { directorScene: scene } })];
    const loaded: string[] = [];
    const { storage } = memoryStorage(new Map());
    const archive = await exportProjectBundle(local, {
      ...storage,
      load: async (_kind, key) => {
        loaded.push(key);
        return undefined;
      },
    });
    const entries = await readZipStore(archive);
    const serialized = new TextDecoder().decode(entries.get("project.json"));

    expect(loaded).toEqual([]);
    expect([...entries.keys()].sort()).toEqual(["manifest.json", "project.json"]);
    expect(serialized).toContain('"assetId": "model_asset_1"');
    expect(serialized).not.toContain("blob:");
    expect(serialized).not.toContain("model/gltf-binary");
    expect(serialized).not.toContain("ownerScope");
  });

  test("rejects undeclared archive entries", async () => {
    const blobs = new Map<string, Blob>([
      ["image:original", new Blob(["image"], { type: "image/png" })],
      ["media:original", new Blob(["video"], { type: "video/mp4" })],
      ["image:panorama", new Blob([pngHeader], { type: "image/png" })],
    ]);
    const { storage } = memoryStorage(blobs);
    const valid = await readZipStore(await exportProjectBundle(project(), storage));
    const entries = [...valid].map(([name, data]) => ({ name, data }));
    entries.push({ name: "objects/hidden.bin", data: new Uint8Array([9]) });

    await expect(importProjectBundle(await createZipStore(entries), storage)).rejects.toThrow(
      "undeclared",
    );
  });

  test("rolls back blobs stored before an import failure", async () => {
    const sourceBlobs = new Map<string, Blob>([
      ["image:original", new Blob(["image"], { type: "image/png" })],
      ["media:original", new Blob(["video"], { type: "video/mp4" })],
      ["image:panorama", new Blob([pngHeader], { type: "image/png" })],
    ]);
    const source = memoryStorage(sourceBlobs);
    const archive = await exportProjectBundle(project(), source.storage);
    const imported: string[] = [];
    const removed: string[] = [];
    const failingStorage: ProjectBundleStorage = {
      load: async () => undefined,
      store: async (kind, blob) => {
        if (imported.length === 1) throw new Error("disk full");
        const key = `${kind}:partial`;
        imported.push(key);
        sourceBlobs.set(key, blob);
        return {
          storageKey: key,
          url: "blob:partial",
          width: kind === "image" ? 2048 : 0,
          height: kind === "image" ? 1024 : 0,
          bytes: blob.size,
          mimeType: blob.type,
        };
      },
      remove: async (_kind, key) => {
        removed.push(key);
      },
    };

    await expect(importProjectBundle(archive, failingStorage)).rejects.toThrow("disk full");
    expect(removed).toEqual(["image:partial"]);
  });

  test("rejects a panorama whose bytes do not match its declared image type", async () => {
    const source = memoryStorage(new Map<string, Blob>([
      ["image:original", new Blob([pngHeader], { type: "image/png" })],
      ["media:original", new Blob(["video"], { type: "video/mp4" })],
      ["image:panorama", new Blob(["disguised payload"], { type: "image/png" })],
    ]));
    const archive = await exportProjectBundle(project(), source.storage);

    await expect(importProjectBundle(archive, memoryStorage(new Map()).storage))
      .rejects.toThrow("声明格式");
  });

  test("rejects inline panorama content that is not declared in the manifest", async () => {
    const inline = createProject("Inline panorama");
    inline.nodes = [createNode("panorama", { x: 0, y: 0 }, { metadata: {
      content: "data:image/png;base64,AAAA",
      naturalWidth: 2048,
      naturalHeight: 1024,
      mimeType: "image/png",
      panoramaProjection: "equirectangular",
    } })];
    const archive = await exportProjectBundle(inline, memoryStorage(new Map()).storage);

    await expect(importProjectBundle(archive, memoryStorage(new Map()).storage))
      .rejects.toThrow("manifest");
  });
});
