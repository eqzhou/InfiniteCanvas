import { describe, expect, test } from "bun:test";
import { readZipStore } from "./zip-store";
import {
  exportWorkspaceBundle,
  importWorkspaceBundle,
  type WorkspaceBundleStorage,
} from "./workspace-bundle";
import { createDefaultConfig, createProject } from "./defaults";
import type { AssetItem, GenerationJob } from "@/types/board";

const TEST_BACKUP_KEY = ["backup", "placeholder"].join("-");
const TEST_LOCAL_KEY = ["local", "placeholder"].join("-");

function fakeStorage(seed: Record<string, Blob> = {}) {
  const blobs = new Map(Object.entries(seed));
  const removed: string[] = [];
  let stores = 0;
  const storage: WorkspaceBundleStorage = {
    load: async (_kind, key) => blobs.get(key),
    store: async (kind, blob) => {
      stores += 1;
      const storageKey = `${kind}:restored-${stores}`;
      blobs.set(storageKey, blob);
      return { storageKey, url: `/api/blobs/${storageKey}` };
    },
    remove: async (_kind, key) => {
      removed.push(key);
      blobs.delete(key);
    },
  };
  return { storage, blobs, removed, stores: () => stores };
}

function snapshot() {
  const config = createDefaultConfig();
  const channel = config.channels[0]!;
  const providers = Object.fromEntries(Object.entries(channel.providers!).map(([kind, provider]) => [
    kind,
    { ...provider, apiKey: `${kind}-backup-secret` },
  ])) as typeof channel.providers;
  const project = createProject("Workspace project");
  project.nodes = [{
    id: "image-node",
    type: "image",
    title: "Shared image",
    position: { x: 10, y: 20 },
    width: 320,
    height: 240,
    metadata: {
      storageKey: "image:shared",
      content: "/api/blobs/image%3Ashared",
      status: "success",
    },
  }];
  const asset: AssetItem = {
    id: "asset-shared",
    kind: "image",
    title: "Shared asset",
    tags: ["shared"],
    storageKey: "image:shared",
    coverUrl: "/api/blobs/image%3Ashared",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const job: GenerationJob = {
    id: "job-shared",
    projectId: project.id,
    kind: "image",
    status: "succeeded",
    prompt: "shared image",
    providerId: channel.id,
    model: "image-model",
    parameters: { referenceStorageKeys: ["image:shared"] },
    result: {
      items: [{
        storageKey: "image:shared",
        url: "/api/blobs/image%3Ashared",
        mimeType: "image/png",
      }],
    },
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  return {
    projects: [project],
    assets: [asset],
    prompts: [{ id: "prompt-1", title: "Prompt", body: "Body", tags: [], source: "local" }],
    config: {
      ...config,
      channels: [{ ...channel, apiKey: TEST_BACKUP_KEY, providers }],
      webdavUrl: "https://dav.backup.example",
      webdavUser: "backup-user",
      webdavPass: "backup-password",
    },
    generationJobs: [job],
  };
}

describe("workspace media bundle", () => {
  test("deduplicates media and restores every reference without exporting credentials", async () => {
    const source = fakeStorage({
      "image:shared": new Blob(["image-bytes"], { type: "image/png" }),
    });
    const sourceSnapshot = snapshot();
    const archive = await exportWorkspaceBundle(sourceSnapshot, source.storage);
    const entries = await readZipStore(archive);
    const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json"))) as {
      media: unknown[];
    };
    const workspaceText = new TextDecoder().decode(entries.get("workspace.json"));
    expect(manifest.media).toHaveLength(1);
    expect(workspaceText).not.toContain("backup-secret");
    expect(workspaceText).not.toContain("backup-password");

    const localConfig = createDefaultConfig();
    const localChannel = localConfig.channels[0]!;
    const localProviders = Object.fromEntries(Object.entries(localChannel.providers!).map(([kind, provider]) => [
      kind,
      { ...provider, apiKey: `${kind}-local-secret` },
    ])) as typeof localChannel.providers;
    const targetConfig = {
      ...localConfig,
      channels: [{
        ...localChannel,
        id: sourceSnapshot.config.channels[0]!.id,
        apiKey: TEST_LOCAL_KEY,
        providers: localProviders,
      }],
      webdavUrl: "https://dav.local.example",
      webdavUser: "local-user",
      webdavPass: "local-password",
    };
    const target = fakeStorage();
    const restored = await importWorkspaceBundle(archive, targetConfig, target.storage);
    const key = restored.projects[0]!.nodes[0]!.metadata.storageKey;

    expect(target.stores()).toBe(1);
    expect(key).toBe("image:restored-1");
    expect(restored.assets[0]?.storageKey).toBe(key);
    expect(restored.generationJobs[0]?.parameters.referenceStorageKeys).toEqual([key]);
    expect((restored.generationJobs[0]?.result.items as Array<{ storageKey: string }>)[0]?.storageKey).toBe(key);
    expect(restored.config.channels[0]?.providers?.image.apiKey).toBe("image-local-secret");
    expect(restored.config.webdavUrl).toBe("https://dav.local.example");
    expect(restored.config.webdavPass).toBe("local-password");
  });

  test("removes imported media when persistent workspace replacement fails", async () => {
    const source = fakeStorage({
      "image:shared": new Blob(["image-bytes"], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(snapshot(), source.storage);
    const target = fakeStorage();
    await expect(importWorkspaceBundle(
      archive,
      createDefaultConfig(),
      target.storage,
      async () => { throw new Error("persistence failed"); },
    )).rejects.toThrow("persistence failed");
    expect(target.stores()).toBe(1);
    expect(target.removed).toEqual(["image:restored-1"]);
    expect(target.blobs.size).toBe(0);
  });
});
