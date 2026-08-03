import { describe, expect, test } from "bun:test";

import {
  createDirectorCaptureStore,
  type DirectorCaptureAdapter,
} from "./director-capture-store";
import { createDefaultDirectorScene } from "@/lib/director-scene";
import { createDirectorShotSnapshot } from "@/lib/director-shot";

function memoryAdapter(): DirectorCaptureAdapter {
  const records = new Map<string, unknown>();
  return {
    entries: async () => [...records.entries()],
    set: async (key, value) => { records.set(key, structuredClone(value)); },
    delete: async (key) => { records.delete(key); },
  };
}

const png = (bytes = 32) => new Blob([new Uint8Array(bytes)], { type: "image/png" });
const ownerScope = "user_tenant_a_user_a";

describe("director capture storage adapter", () => {
  test("persists an immutable compact shot snapshot captured with the PNG", async () => {
    const store = createDirectorCaptureStore(memoryAdapter());
    const scene = createDefaultDirectorScene();
    const shot = createDirectorShotSnapshot(scene, "director_a");
    const saved = await store.add({
      ownerScope,
      projectId: "project_a",
      directorNodeId: "director_a",
      cameraId: shot.camera.id,
      cameraName: shot.camera.name,
      createdAt: "2026-08-02T10:00:00.000Z",
      width: 1600,
      height: 900,
      blob: png(),
      shot,
    });
    scene.cameras[0]!.focalLength = 200;
    shot.camera.focalLength = 10;

    const [reloaded] = await store.list(ownerScope, "project_a", "director_a");
    expect(saved.shot).toBeDefined();
    expect(saved.shot?.camera.focalLength).not.toBe(10);
    expect(reloaded?.shot).toEqual(saved.shot);
    expect(reloaded?.shot?.camera.focalLength).not.toBe(200);
  });
  test("isolates captures by project and director while sorting newest first", async () => {
    const store = createDirectorCaptureStore(memoryAdapter());
    const first = await store.add({
      ownerScope,
      projectId: "project_a",
      directorNodeId: "director_a",
      cameraId: "camera_main",
      cameraName: "主摄像机",
      createdAt: "2026-07-24T10:00:00.000Z",
      width: 1600,
      height: 900,
      blob: png(),
    });
    const second = await store.add({
      ownerScope,
      projectId: "project_a",
      directorNodeId: "director_a",
      cameraId: "camera_close",
      cameraName: "近景",
      createdAt: "2026-07-24T11:00:00.000Z",
      width: 1024,
      height: 1024,
      blob: png(),
    });
    await store.add({
      ownerScope,
      projectId: "project_b",
      directorNodeId: "director_a",
      cameraId: "camera_main",
      cameraName: "其它项目",
      createdAt: "2026-07-24T12:00:00.000Z",
      width: 1600,
      height: 900,
      blob: png(),
    });
    await store.add({
      ownerScope: "user_tenant_b_user_b",
      projectId: "project_a",
      directorNodeId: "director_a",
      cameraId: "camera_main",
      cameraName: "其它账号",
      createdAt: "2026-07-24T13:00:00.000Z",
      width: 1600,
      height: 900,
      blob: png(),
    });

    const listed = await store.list(ownerScope, "project_a", "director_a");
    expect(listed.map((capture) => capture.id)).toEqual([second.id, first.id]);
    expect(listed.every((capture) => capture.projectId === "project_a")).toBe(true);
    expect(listed.every((capture) => capture.ownerScope === ownerScope)).toBe(true);
  });

  test("deletes selected captures and clears only the requested tray", async () => {
    const store = createDirectorCaptureStore(memoryAdapter());
    const captures = await Promise.all(["camera_a", "camera_b"].map((cameraId, index) => store.add({
      ownerScope,
      projectId: "project_a",
      directorNodeId: "director_a",
      cameraId,
      cameraName: cameraId,
      createdAt: `2026-07-24T1${index}:00:00.000Z`,
      width: 1600,
      height: 900,
      blob: png(),
    })));
    await store.add({
      ownerScope,
      projectId: "project_a",
      directorNodeId: "director_b",
      cameraId: "camera_main",
      cameraName: "保留",
      createdAt: "2026-07-24T12:00:00.000Z",
      width: 1600,
      height: 900,
      blob: png(),
    });

    await store.deleteMany(ownerScope, "project_a", "director_a", [captures[0]!.id]);
    expect((await store.list(ownerScope, "project_a", "director_a")).map((item) => item.id)).toEqual([captures[1]!.id]);
    await store.clear(ownerScope, "project_a", "director_a");
    expect(await store.list(ownerScope, "project_a", "director_a")).toEqual([]);
    expect(await store.list(ownerScope, "project_a", "director_b")).toHaveLength(1);
  });

  test("rejects unsafe metadata, unsupported blobs, and bounded-store overflow", async () => {
    const store = createDirectorCaptureStore(memoryAdapter(), {
      maxPerDirector: 2,
      maxGlobal: 3,
      maxTotalBytes: 96,
      maxBlobBytes: 64,
    });
    const input = {
      ownerScope,
      projectId: "project_a",
      directorNodeId: "director_a",
      cameraId: "camera_main",
      cameraName: "主摄像机",
      createdAt: "2026-07-24T10:00:00.000Z",
      width: 1600,
      height: 900,
      blob: png(32),
    };
    await store.add(input);
    await store.add({ ...input, cameraId: "camera_b", createdAt: "2026-07-24T11:00:00.000Z" });
    await expect(store.add({ ...input, cameraId: "camera_c" })).rejects.toThrow("2");
    await store.add({ ...input, ownerScope: "user_tenant_b_user_b", directorNodeId: "director_b" });
    await expect(store.add({ ...input, ownerScope: "user_tenant_c_user_c", directorNodeId: "director_c" })).rejects.toThrow("3");
    await expect(store.add({ ...input, directorNodeId: "director_b", blob: new Blob(["x"], { type: "text/plain" }) })).rejects.toThrow("PNG");
    await expect(store.add({ ...input, directorNodeId: "director_b", blob: png(65) })).rejects.toThrow("64");
    await expect(store.add({ ...input, directorNodeId: "../unsafe" })).rejects.toThrow("directorNodeId");
  });

  test("prunes deleted projects and director nodes only inside the active owner scope", async () => {
    const store = createDirectorCaptureStore(memoryAdapter());
    for (const [scope, projectId, directorNodeId] of [
      [ownerScope, "project_keep", "director_keep"],
      [ownerScope, "project_keep", "director_orphan"],
      [ownerScope, "project_drop", "director_drop"],
      ["user_tenant_b_user_b", "project_drop", "director_drop"],
    ] as const) {
      await store.add({
        ownerScope: scope,
        projectId,
        directorNodeId,
        cameraId: "camera_main",
        cameraName: "主摄像机",
        createdAt: "2026-07-24T10:00:00.000Z",
        width: 1600,
        height: 900,
        blob: png(),
      });
    }

    const now = Date.parse("2026-07-24T14:00:00.000Z");
    await store.prune(ownerScope, { project_keep: ["director_keep"] }, now);
    expect(await store.list(ownerScope, "project_keep", "director_keep")).toHaveLength(1);
    expect((await store.list(ownerScope, "project_keep", "director_orphan"))[0]?.orphanedAt).toBe(new Date(now).toISOString());
    expect(await store.list(ownerScope, "project_drop", "director_drop")).toHaveLength(0);
    expect(await store.list("user_tenant_b_user_b", "project_drop", "director_drop")).toHaveLength(1);
    await store.prune(ownerScope, { project_keep: ["director_keep"] }, now + 24 * 60 * 60 * 1000 + 1);
    expect(await store.list(ownerScope, "project_keep", "director_orphan")).toHaveLength(0);
  });

  test("deletes pre-owner and malformed capture records instead of leaving invisible blobs", async () => {
    const adapter = memoryAdapter();
    await adapter.set("capture:project_a:director_a:legacy", {
      id: "legacy",
      projectId: "project_a",
      directorNodeId: "director_a",
      cameraId: "camera_main",
      cameraName: "旧截图",
      createdAt: "2026-07-24T10:00:00.000Z",
      width: 1600,
      height: 900,
      bytes: 32,
      mimeType: "image/png",
      blob: png(),
    } as any);
    const store = createDirectorCaptureStore(adapter);
    expect(await store.list(ownerScope, "project_a", "director_a")).toEqual([]);
    expect(await adapter.entries()).toEqual([]);
  });
});
