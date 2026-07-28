import { describe, expect, test } from "bun:test";

import {
  createDirectorModelStore,
  validateDirectorGlb,
  type DirectorModelRecord,
} from "./director-model-store";

function glb(json: Record<string, unknown> = { asset: { version: "2.0" }, scene: 0, scenes: [{}] }): Blob {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + paddedLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, paddedLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(encoded, 20);
  bytes.fill(0x20, 20 + encoded.length);
  return new Blob([bytes], { type: "model/gltf-binary" });
}

async function appendChunk(blob: Blob, type: number, payload = new Uint8Array(4)): Promise<Blob> {
  const source = new Uint8Array(await blob.arrayBuffer());
  const payloadLength = Math.ceil(payload.length / 4) * 4;
  const bytes = new Uint8Array(source.length + 8 + payloadLength);
  bytes.set(source);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, bytes.length, true);
  view.setUint32(source.length, payloadLength, true);
  view.setUint32(source.length + 4, type, true);
  bytes.set(payload, source.length + 8);
  return new Blob([bytes], { type: "model/gltf-binary" });
}

const glbWithBinary = (manifest: Record<string, unknown>, payload = new Uint8Array(4)) =>
  appendChunk(glb(manifest), 0x004e4942, payload);

async function mutateGlb(blob: Blob, mutate: (bytes: Uint8Array, view: DataView) => void): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  mutate(bytes, new DataView(bytes.buffer));
  return new Blob([bytes], { type: "model/gltf-binary" });
}

function memoryAdapter(seed: Array<[string, unknown]> = []) {
  const values = new Map(seed);
  return {
    values,
    adapter: {
      entries: async () => [...values.entries()],
      set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      delete: async (key: string) => { values.delete(key); },
    },
  };
}

const ref = {
  ownerScope: "browser_owner",
  projectId: "project_1",
  directorNodeId: "director_1",
  objectId: "model_1",
  assetId: "asset_1",
};

describe("director local GLB validation", () => {
  test("accepts an embedded GLB v2 and rejects malformed or network-referencing files", async () => {
    await expect(validateDirectorGlb(glb())).resolves.toMatchObject({ version: 2 });
    await expect(validateDirectorGlb(new Blob(["not glb"], { type: "model/gltf-binary" }))).rejects.toThrow("GLB");
    await expect(validateDirectorGlb(glb({
      asset: { version: "2.0" },
      buffers: [{ uri: "https://example.com/private.bin", byteLength: 10 }],
    }))).rejects.toThrow("external");
    await expect(validateDirectorGlb(glb({
      asset: { version: "2.0" },
      accessors: [{ count: 2_000_001 }],
    }))).rejects.toThrow("accessor");
    await expect(validateDirectorGlb(glb({
      asset: { version: "2.0" },
      accessors: [{ count: 2_000_000, type: "MAT4", componentType: 5126 }],
    }))).rejects.toThrow("decoded accessor");
    await expect(validateDirectorGlb(await appendChunk(glb(), 0x4e4f534a))).rejects.toThrow("chunk structure");
    const oneBinary = await appendChunk(glb({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] }), 0x004e4942);
    await expect(validateDirectorGlb(await appendChunk(oneBinary, 0x004e4942))).rejects.toThrow("chunk structure");
  });

  test("rejects malformed headers, manifests, references, and decoded resource bombs", async () => {
    await expect(validateDirectorGlb(new Blob([await glb().arrayBuffer()], { type: "text/plain" }))).rejects.toThrow("MIME");
    await expect(validateDirectorGlb(await mutateGlb(glb(), (_bytes, view) => view.setUint32(4, 1, true)))).rejects.toThrow("version 2");
    await expect(validateDirectorGlb(await mutateGlb(glb(), (_bytes, view) => view.setUint32(8, 20, true)))).rejects.toThrow("declared length");
    await expect(validateDirectorGlb(await mutateGlb(glb(), (_bytes, view) => view.setUint32(16, 0x004e4942, true)))).rejects.toThrow("JSON chunk");
    await expect(validateDirectorGlb(await mutateGlb(glb(), (_bytes, view) => view.setUint32(12, 3, true)))).rejects.toThrow("chunk length");

    const malformedJson = await mutateGlb(glb(), (bytes) => { bytes.fill(0xff, 20); });
    await expect(validateDirectorGlb(malformedJson)).rejects.toThrow(/UTF-8|malformed/);
    await expect(validateDirectorGlb(glb({ asset: { version: "1.0" } }))).rejects.toThrow("asset version");
    await expect(validateDirectorGlb(glb({ asset: { version: "2.0" }, nodes: {} }))).rejects.toThrow("nodes collection");
    await expect(validateDirectorGlb(glb({ asset: { version: "2.0" }, nested: { value: 1 } }), { maxJsonDepth: 1 })).rejects.toThrow("nesting");
    await expect(validateDirectorGlb(glb({ asset: { version: "2.0" }, a: 1, b: 2 }), { maxJsonEntries: 2 })).rejects.toThrow("complex");

    await expect(validateDirectorGlb(glb({ asset: { version: "2.0" }, buffers: [{ byteLength: -1 }] }))).rejects.toThrow("buffer byteLength");
    await expect(validateDirectorGlb(glb({
      asset: { version: "2.0" },
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteOffset: 2, byteLength: 4 }],
    }))).rejects.toThrow("bufferView reference");
    await expect(validateDirectorGlb(await glbWithBinary({
      asset: { version: "2.0" },
      buffers: [{ byteLength: 16 }],
      bufferViews: [{ buffer: 0, byteLength: 16 }],
      accessors: [{ bufferView: 0, count: 2, type: "VEC3", componentType: 5126 }],
    }, new Uint8Array(16)))).rejects.toThrow("accessor byte range");
    await expect(validateDirectorGlb(glb({
      asset: { version: "2.0" },
      accessors: [{ count: 2, type: "SCALAR", componentType: 5126, sparse: { count: 3 } }],
    }))).rejects.toThrow("sparse accessor");
    await expect(validateDirectorGlb(glb({
      asset: { version: "2.0" },
      accessors: [{ count: 1, type: "SCALAR", componentType: 5126 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 2 } }] }],
    }))).rejects.toThrow("accessor reference");
    await expect(validateDirectorGlb(glb({
      asset: { version: "2.0" },
      extensionsRequired: ["KHR_draco_mesh_compression"],
    }))).rejects.toThrow("compressed");
    await expect(validateDirectorGlb(await glbWithBinary({
      asset: { version: "2.0" }, buffers: [{ byteLength: 8 }],
    }, new Uint8Array(4)))).rejects.toThrow("binary chunk");
  });

  test("bounds embedded PNG and JPEG dimensions before Three decodes them", async () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    const pngView = new DataView(png.buffer);
    pngView.setUint32(16, 2);
    pngView.setUint32(20, 3);
    const pngManifest = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: png.length }],
      bufferViews: [{ buffer: 0, byteLength: png.length }],
      images: [{ bufferView: 0, mimeType: "image/png" }],
    };
    await expect(validateDirectorGlb(await glbWithBinary(pngManifest, png))).resolves.toMatchObject({ version: 2 });

    pngView.setUint32(16, 8192);
    pngView.setUint32(20, 8192);
    await expect(validateDirectorGlb(await glbWithBinary(pngManifest, png))).rejects.toThrow("too complex");

    const jpeg = new Uint8Array(20);
    jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03]);
    const jpegManifest = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: jpeg.length }],
      bufferViews: [{ buffer: 0, byteLength: jpeg.length }],
      images: [{ bufferView: 0, mimeType: "image/jpeg" }],
    };
    await expect(validateDirectorGlb(await glbWithBinary(jpegManifest, jpeg))).resolves.toMatchObject({ version: 2 });
    await expect(validateDirectorGlb(await glbWithBinary({ ...jpegManifest, images: [{ bufferView: 0, mimeType: "image/webp" }] }, jpeg))).rejects.toThrow("format");
  });
});

describe("director browser-local model store", () => {
  test("isolates a model by owner, project, director, object, and asset id", async () => {
    const { adapter } = memoryAdapter();
    const store = createDirectorModelStore(adapter);
    await store.put({ ...ref, fileName: "hero.glb", blob: glb() });

    expect(await store.get(ref)).toMatchObject({ ...ref, fileName: "hero.glb" });
    expect(await store.get({ ...ref, ownerScope: "browser_other" })).toBeNull();
    expect(await store.get({ ...ref, projectId: "project_2" })).toBeNull();
    expect(await store.get({ ...ref, directorNodeId: "director_2" })).toBeNull();
    expect(await store.get({ ...ref, objectId: "model_2" })).toBeNull();
    expect(await store.get({ ...ref, assetId: "asset_2" })).toBeNull();
    expect(await store.list(ref.ownerScope, ref.projectId, ref.directorNodeId)).toHaveLength(1);
    expect(await store.list(ref.ownerScope, ref.projectId, "director_2")).toEqual([]);
  });

  test("relinks the same descriptor atomically while preserving its identity", async () => {
    const { adapter } = memoryAdapter();
    const store = createDirectorModelStore(adapter);
    await store.put({ ...ref, fileName: "old.glb", blob: glb() });
    const replacement = glb({ asset: { version: "2.0", generator: "replacement" }, scenes: [{}] });
    const updated = await store.put({ ...ref, fileName: "new.glb", blob: replacement });

    expect(updated.assetId).toBe(ref.assetId);
    expect(updated.fileName).toBe("new.glb");
    expect(updated.blob.size).toBe(replacement.size);
    expect((await store.get(ref))?.blob.size).toBe(replacement.size);
  });

  test("stores portable ArrayBuffer payloads while reading legacy Blob records", async () => {
    const { adapter, values } = memoryAdapter();
    const store = createDirectorModelStore(adapter);
    const source = glb();
    await store.put({ ...ref, fileName: "portable.glb", blob: source });

    const stored = [...values.values()][0] as {
      blob?: { version?: unknown; mimeType?: unknown; bytes?: unknown };
    };
    expect(stored.blob).not.toBeInstanceOf(Blob);
    expect(stored.blob?.version).toBe(1);
    expect(stored.blob?.mimeType).toBe("model/gltf-binary");
    expect(stored.blob?.bytes).toBeInstanceOf(ArrayBuffer);
    expect((stored.blob?.bytes as ArrayBuffer).byteLength).toBe(source.size);
    expect((await store.get(ref))?.blob.size).toBe(source.size);

    const legacy = {
      ...(await store.get(ref))!,
      fileName: "legacy.glb",
      blob: source,
    };
    const legacyMemory = memoryAdapter([[
      [...values.keys()][0]!,
      legacy,
    ]]);
    const legacyStore = createDirectorModelStore(legacyMemory.adapter);
    expect(await legacyStore.get(ref)).toMatchObject({ fileName: "legacy.glb", bytes: source.size });
    await legacyStore.prune(ref.ownerScope, { project_1: { director_1: {} } }, Date.parse("2026-07-28T00:00:00.000Z"));
    const migrated = [...legacyMemory.values.values()][0] as { blob?: unknown; orphanedAt?: unknown };
    expect(migrated.blob).not.toBeInstanceOf(Blob);
    expect(migrated.orphanedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  test("uses unambiguous composite keys even when valid ids contain colons", async () => {
    const { adapter, values } = memoryAdapter();
    const store = createDirectorModelStore(adapter);
    const first = { ...ref, directorNodeId: "director:a", objectId: "model", assetId: "asset" };
    const second = { ...ref, directorNodeId: "director", objectId: "a:model", assetId: "asset" };
    await store.put({ ...first, fileName: "first.glb", blob: glb() });
    await store.put({ ...second, fileName: "second.glb", blob: glb() });

    expect(values.size).toBe(2);
    expect((await store.get(first))?.fileName).toBe("first.glb");
    expect((await store.get(second))?.fileName).toBe("second.glb");
  });

  test("enforces bounded physical storage and rejects unsafe file names and MIME", async () => {
    const { adapter } = memoryAdapter();
    const store = createDirectorModelStore(adapter, { maxGlobal: 1, maxTotalBytes: 4096, maxBlobBytes: 4096 });
    await store.put({ ...ref, fileName: "one.glb", blob: glb() });
    await expect(store.put({ ...ref, objectId: "model_2", assetId: "asset_2", fileName: "two.glb", blob: glb() })).rejects.toThrow("limited");
    await expect(store.put({ ...ref, fileName: "../escape.glb", blob: glb() })).rejects.toThrow("fileName");
    await expect(store.put({ ...ref, fileName: "bad.glb", blob: new Blob(["bad"], { type: "text/plain" }) })).rejects.toThrow("MIME");

    const bytesLimited = createDirectorModelStore(memoryAdapter().adapter, {
      maxGlobal: 10,
      maxTotalBytes: glb().size,
      maxBlobBytes: 4096,
    });
    await bytesLimited.put({ ...ref, fileName: "one.glb", blob: glb() });
    await expect(bytesLimited.put({ ...ref, objectId: "model_2", assetId: "asset_2", fileName: "two.glb", blob: glb() }))
      .rejects.toThrow("bytes");
  });

  test("cleans malformed legacy records and supports explicit and project-level deletion", async () => {
    const { adapter, values } = memoryAdapter([["model:legacy", { ownerScope: "missing-fields" }]]);
    const store = createDirectorModelStore(adapter);
    await store.put({ ...ref, fileName: "hero.glb", blob: glb() });
    expect(values.has("model:legacy")).toBe(false);

    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
    await store.put({ ...ref, fileName: "hero.glb", blob: glb() });
    await store.prune(ref.ownerScope, {});
    expect(await store.get(ref)).toBeNull();
  });

  test("uses a tombstone grace period so deleting and undo-restoring a model keeps its file", async () => {
    const { adapter } = memoryAdapter();
    const store = createDirectorModelStore(adapter);
    await store.put({ ...ref, fileName: "hero.glb", blob: glb() });
    const now = Date.parse("2026-07-24T00:00:00.000Z");

    await store.prune(ref.ownerScope, { project_1: { director_1: {} } }, now);
    expect((await store.get(ref))?.orphanedAt).toBe("2026-07-24T00:00:00.000Z");

    await store.prune(ref.ownerScope, { project_1: { director_1: { model_1: "asset_1" } } }, now + 1);
    expect((await store.get(ref))?.orphanedAt).toBeUndefined();

    await store.prune(ref.ownerScope, { project_1: { director_1: {} } }, now + 2);
    await store.prune(ref.ownerScope, { project_1: { director_1: {} } }, now + 24 * 60 * 60 * 1000 + 3);
    expect(await store.get(ref)).toBeNull();
  });
});
