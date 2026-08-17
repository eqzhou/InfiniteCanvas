import { describe, expect, test } from "bun:test";
import { createZipStore, readZipStore } from "./zip-store";
import {
  exportWorkspaceBundle,
  importWorkspaceBundle,
  WorkspaceReplacementRollbackError,
  type WorkspaceBundleStorage,
} from "./workspace-bundle";
import { createDefaultConfig, createNode, createProject } from "./defaults";
import type { AssetItem, GenerationJob } from "@/types/board";
import { buildWorkflowGenerationJob } from "./workflow-job";
import { parseWorkflowTemplate } from "./workflow-document";
import { createFilmDocument } from "./film-document";

const TEST_BACKUP_KEY = ["backup", "placeholder"].join("-");
const TEST_LOCAL_KEY = ["local", "placeholder"].join("-");
const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

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
      return {
        storageKey,
        url: `/api/blobs/${storageKey}`,
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
    workflowTemplates: [],
  };
}

describe("workspace media bundle", () => {
  test("round trips FilmDocument payloads and their protected film media", async () => {
    const sourceSnapshot = snapshot();
    const project = createProject("Film workspace", "film");
    const film = createFilmDocument(project.id, "2026-08-08T00:00:00.000Z");
    film.episodes = [{ id: "episode-film", revision: 1, order: 0, title: "Episode", synopsis: "", status: "draft" }];
    film.scenes = [{ id: "scene-film", revision: 1, episodeId: "episode-film", order: 0, heading: "INT. ROOM - DAY", synopsis: "", status: "draft" }];
    film.shots = [{ id: "shot-film", revision: 1, sceneId: "scene-film", order: 0, title: "Shot", description: "First frame", status: "draft", durationSeconds: 4, aspectRatio: "16:9", identityVersionIds: [], firstFrameStorageKey: "image:film-first-frame" }];
    film.assets = [{
      id: "asset_film_voice", revision: 1, kind: "voice", title: "Narrator", status: "draft",
      description: "Voice identity", mediaStorageKey: "media:film-voice",
    }];
    film.dialogues = [{
      id: "dialogue-film", revision: 1, shotId: "shot-film", order: 0, kind: "narration",
      text: "Narration", status: "draft", audioStorageKey: "media:film-voice",
    }];
    film.tasks = [{
      id: "task-film", revision: 1, stage: "first_frame", shotId: "shot-film", title: "Frozen frame task",
      status: "needs_review", progress: 1, createdAt: film.createdAt, updatedAt: film.updatedAt,
      snapshot: {
        shotRevision: 1, prompt: "First frame", providerId: "provider", model: "model", config: {},
        identityVersions: [{ ...film.assets[0]! }], referenceStorageKeys: ["image:film-first-frame"],
        estimatedGenerations: 1, createdAt: film.createdAt,
      },
    }];
    film.deliverables = [{
      id: "deliverable_film_mp4", revision: 1, kind: "mp4", title: "Master", status: "approved",
      mimeType: "video/mp4", storageKey: "film:deliverable:master", bytes: 6,
      createdAt: "2026-08-08T00:00:00.000Z",
    }];
    sourceSnapshot.projects = [project];
    sourceSnapshot.assets = [];
    sourceSnapshot.generationJobs = [];
    const archive = await exportWorkspaceBundle(
      { ...sourceSnapshot, films: [film] },
      fakeStorage({
        "image:film-first-frame": new Blob(["frame"], { type: "image/png" }),
        "media:film-voice": new Blob(["voice"], { type: "audio/mpeg" }),
        "film:deliverable:master": new Blob(["master"], { type: "video/mp4" }),
      }).storage,
    );

    const target = fakeStorage();
    const restored = await importWorkspaceBundle(archive, createDefaultConfig(), target.storage);

    expect(restored.films).toHaveLength(1);
    expect(restored.films?.[0]?.projectId).toBe(project.id);
    expect(restored.films?.[0]?.shots[0]?.firstFrameStorageKey).toBe("image:restored-1");
    expect(restored.films?.[0]?.assets[0]?.mediaStorageKey).toBe("media:restored-2");
    expect(restored.films?.[0]?.dialogues?.[0]?.audioStorageKey).toBe("media:restored-2");
    expect(restored.films?.[0]?.tasks[0]?.snapshot?.identityVersions[0]?.mediaStorageKey).toBe("media:restored-2");
    expect(restored.films?.[0]?.tasks[0]?.snapshot?.referenceStorageKeys).toEqual(["image:restored-1"]);
    expect(restored.films?.[0]?.deliverables[0]?.storageKey).toBe("media:restored-3");
    expect(target.blobs.get("image:restored-1")?.type).toBe("image/png");
  });

  test("provides strict media identities and removes only confirmed migrated uploads", async () => {
    const sourceSnapshot = snapshot();
    const project = createProject("Safe film workspace", "film");
    const film = createFilmDocument(project.id, "2026-08-08T00:00:00.000Z");
    film.assets = [{ id: "asset-safe", revision: 1, kind: "style", title: "Look", status: "approved", description: "", mediaStorageKey: "image:film-safe" }];
    film.deliverables = [{ id: "delivery-safe", revision: 1, kind: "mp4", title: "Master", status: "approved", mimeType: "video/mp4", storageKey: "film:deliverable:safe", bytes: 6, createdAt: film.createdAt }];
    sourceSnapshot.projects = [project]; sourceSnapshot.assets = []; sourceSnapshot.generationJobs = [];
    const archive = await exportWorkspaceBundle({ ...sourceSnapshot, films: [film] }, fakeStorage({
      "image:film-safe": new Blob(["image"], { type: "image/png" }),
      "film:deliverable:safe": new Blob(["master"], { type: "video/mp4" }),
    }).storage);
    const target = fakeStorage();

    const restored = await importWorkspaceBundle(archive, createDefaultConfig(), target.storage, async (candidate, context) => {
      expect(context.media).toHaveLength(2);
      expect(context.media.every((item) => item.sha256.length === 64 && item.objectVersion.startsWith("m1-") && item.mimeType && item.bytes > 0)).toBe(true);
      await context.cleanupMigrated([context.media[1]!.storageKey]);
      return candidate;
    });

    expect(restored.films?.[0]?.assets[0]?.mediaStorageKey).toBe("image:restored-1");
    expect(restored.films?.[0]?.deliverables[0]?.storageKey).toBe("media:restored-2");
    expect(target.removed).toEqual(["media:restored-2"]);
    expect(target.blobs.has("image:restored-1")).toBe(true);
  });

  test("round trips preview thumbnails independently of the original media", async () => {
    const source = fakeStorage({
      "image:full": new Blob(["full-bytes"], { type: "image/png" }),
      "image:thumb": new Blob(["thumb-bytes"], { type: "image/jpeg" }),
    });
    const sourceSnapshot = snapshot();
    sourceSnapshot.projects[0]!.nodes[0]!.metadata = {
      ...sourceSnapshot.projects[0]!.nodes[0]!.metadata,
      storageKey: "image:full",
      thumbnailStorageKey: "image:thumb",
      content: "/api/blobs/image%3Afull",
    };
    sourceSnapshot.assets[0] = {
      ...sourceSnapshot.assets[0]!,
      storageKey: "image:full",
      thumbnailStorageKey: "image:thumb",
      coverUrl: "/api/blobs/image%3Afull",
    };
    sourceSnapshot.generationJobs[0]!.parameters = { referenceStorageKeys: ["image:full"] };
    sourceSnapshot.generationJobs[0]!.result = {
      items: [{ storageKey: "image:full", thumbnailStorageKey: "image:thumb" }],
    };

    const target = fakeStorage();
    const restored = await importWorkspaceBundle(
      await exportWorkspaceBundle(sourceSnapshot, source.storage),
      createDefaultConfig(),
      target.storage,
    );
    const originalKey = restored.projects[0]!.nodes[0]!.metadata.storageKey;
    const previewKey = restored.projects[0]!.nodes[0]!.metadata.thumbnailStorageKey;
    expect(originalKey).toStartWith("image:restored-");
    expect(previewKey).toStartWith("image:restored-");
    expect(previewKey).not.toBe(originalKey);
    expect(restored.assets[0]?.thumbnailStorageKey).toBe(previewKey);
    expect((restored.generationJobs[0]?.result.items as Array<{ thumbnailStorageKey?: string }>)[0]?.thumbnailStorageKey)
      .toBe(previewKey);
  });

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
    expect(restored.workflowTemplates).toEqual([]);
  });

  test("round trips v2 personal workflow templates and nested workflow media", async () => {
    const sourceSnapshot = snapshot();
    const timestamp = "2026-07-18T00:00:00.000Z";
    const template = parseWorkflowTemplate({
      schemaVersion: 1,
      id: "personal_bundle_workflow",
      revision: 2,
      scope: "personal",
      title: "工作区系列图",
      description: "验证工作流备份",
      category: "测试",
      variables: [{ id: "reference", kind: "image", label: "参考图", required: true }],
      steps: [{
        id: "render",
        title: "生成",
        promptTemplate: "保持参考图主体",
        providerId: "",
        parameters: { size: "1024x1024", count: 1 },
        references: [{ source: "variable", variableId: "reference" }],
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const workflowJob = buildWorkflowGenerationJob({
      id: "workflow_bundle_run",
      projectId: sourceSnapshot.projects[0]!.id,
      template,
      values: { reference: ["image:workflow-input"] },
      executor: "browser",
      timestamp,
    });
    workflowJob.status = "succeeded";
    workflowJob.result = {
      steps: {
        render: {
          status: "succeeded",
          childJobId: "workflow_bundle_run_render",
          storageKeys: ["image:workflow-step"],
        },
      },
      outputStorageKeys: ["image:workflow-step"],
    };
    sourceSnapshot.workflowTemplates = [template];
    sourceSnapshot.generationJobs = [...sourceSnapshot.generationJobs, workflowJob];
    const source = fakeStorage({
      "image:shared": new Blob(["shared"], { type: "image/png" }),
      "image:workflow-input": new Blob(["input"], { type: "image/png" }),
      "image:workflow-step": new Blob(["step"], { type: "image/png" }),
    });

    const archive = await exportWorkspaceBundle(sourceSnapshot, source.storage);
    const entries = await readZipStore(archive);
    const workspace = JSON.parse(new TextDecoder().decode(entries.get("workspace.json")));
    expect(workspace.version).toBe(3);
    expect(workspace.workflowTemplates).toEqual([template]);

    const target = fakeStorage();
    const restored = await importWorkspaceBundle(archive, createDefaultConfig(), target.storage);
    const restoredJob = restored.generationJobs.find((job) => job.id === workflowJob.id)!;
    const values = restoredJob.parameters.values as Record<string, string[]>;
    const result = restoredJob.result as {
      steps: Record<string, { storageKeys: string[] }>;
      outputStorageKeys: string[];
    };
    expect(target.stores()).toBe(3);
    expect(restored.workflowTemplates).toEqual([template]);
    expect(values.reference[0]).toStartWith("image:restored-");
    expect(result.steps.render!.storageKeys[0]).toStartWith("image:restored-");
    expect(result.outputStorageKeys[0]).toStartWith("image:restored-");
    expect(result.outputStorageKeys[0]).toBe(result.steps.render!.storageKeys[0]);
    expect(values.reference[0]).not.toBe(result.outputStorageKeys[0]);
  });

  test("migrates a v1 workspace document to an empty workflow template catalog", async () => {
    const source = fakeStorage({
      "image:shared": new Blob(["image-bytes"], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(snapshot(), source.storage);
    const entries = await readZipStore(archive);
    const workspace = JSON.parse(new TextDecoder().decode(entries.get("workspace.json")));
    workspace.version = 1;
    delete workspace.workflowTemplates;
    delete workspace.films;
    const legacyArchive = await createZipStore([...entries.entries()].map(([name, data]) => ({
      name,
      data: name === "workspace.json" ? JSON.stringify(workspace) : data,
    })));

    const restored = await importWorkspaceBundle(legacyArchive, createDefaultConfig(), fakeStorage().storage);
    expect(restored.workflowTemplates).toEqual([]);
  });

  test("rejects v1 documents that smuggle v2 workflow templates before media restore", async () => {
    const source = fakeStorage({
      "image:shared": new Blob(["image-bytes"], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(snapshot(), source.storage);
    const entries = await readZipStore(archive);
    const workspace = JSON.parse(new TextDecoder().decode(entries.get("workspace.json")));
    workspace.version = 1;
    const legacyArchive = await createZipStore([...entries.entries()].map(([name, data]) => ({
      name,
      data: name === "workspace.json" ? JSON.stringify(workspace) : data,
    })));
    const target = fakeStorage();

    await expect(importWorkspaceBundle(legacyArchive, createDefaultConfig(), target.storage))
      .rejects.toThrow("v1 workspace");
    expect(target.stores()).toBe(0);
  });

  test("removes restored nested workflow media when workspace persistence fails", async () => {
    const sourceSnapshot = snapshot();
    const timestamp = "2026-07-18T00:00:00.000Z";
    const template = parseWorkflowTemplate({
      schemaVersion: 1,
      id: "personal_rollback_workflow",
      revision: 1,
      scope: "personal",
      title: "回滚任务",
      description: "验证媒体补偿",
      category: "测试",
      variables: [{ id: "reference", kind: "image", label: "参考图", required: true }],
      steps: [{
        id: "render",
        title: "生成",
        promptTemplate: "生成结果",
        providerId: "",
        parameters: { size: "1024x1024", count: 1 },
        references: [],
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const job = buildWorkflowGenerationJob({
      id: "workflow_rollback_run",
      template,
      values: { reference: ["image:workflow-input"] },
      executor: "browser",
      timestamp,
    });
    job.status = "succeeded";
    job.result = {
      steps: { render: { status: "succeeded", storageKeys: ["image:workflow-output"] } },
      outputStorageKeys: ["image:workflow-output"],
    };
    sourceSnapshot.projects[0]!.nodes = [];
    sourceSnapshot.assets = [];
    sourceSnapshot.generationJobs = [job];
    const source = fakeStorage({
      "image:workflow-input": new Blob(["input"], { type: "image/png" }),
      "image:workflow-output": new Blob(["output"], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(sourceSnapshot, source.storage);
    const target = fakeStorage();

    await expect(importWorkspaceBundle(
      archive,
      createDefaultConfig(),
      target.storage,
      async () => { throw new Error("workflow persistence failed"); },
    )).rejects.toThrow("workflow persistence failed");
    expect(target.stores()).toBe(2);
    expect(target.removed).toEqual(["image:restored-1", "image:restored-2"]);
    expect(target.blobs.size).toBe(0);
  });

  test("rejects active server workflow runs before restoring media", async () => {
    const sourceSnapshot = snapshot();
    const timestamp = "2026-07-18T00:00:00.000Z";
    const template = parseWorkflowTemplate({
      schemaVersion: 1,
      id: "personal_active_workflow",
      revision: 1,
      scope: "personal",
      title: "活动任务",
      description: "不能跨服务恢复",
      category: "测试",
      variables: [],
      steps: [{
        id: "render",
        title: "生成",
        promptTemplate: "生成图像",
        providerId: "",
        parameters: { size: "1024x1024", count: 1 },
        references: [],
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    sourceSnapshot.generationJobs = [...sourceSnapshot.generationJobs, buildWorkflowGenerationJob({
      id: "workflow_active_server",
      template,
      values: {},
      executor: "workflow",
      timestamp,
    })];
    const source = fakeStorage({
      "image:shared": new Blob(["image-bytes"], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(sourceSnapshot, source.storage);
    const target = fakeStorage();

    await expect(importWorkspaceBundle(archive, createDefaultConfig(), target.storage))
      .rejects.toThrow("active workflow");
    expect(target.stores()).toBe(0);
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

  test("retains imported media when workspace rollback is incomplete", async () => {
    const source = fakeStorage({
      "image:shared": new Blob(["image-bytes"], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(snapshot(), source.storage);
    const target = fakeStorage();
    await expect(importWorkspaceBundle(
      archive,
      createDefaultConfig(),
      target.storage,
      async () => { throw new WorkspaceReplacementRollbackError(new Error("commit"), new Error("rollback")); },
    )).rejects.toBeInstanceOf(WorkspaceReplacementRollbackError);
    expect(target.stores()).toBe(1);
    expect(target.removed).toEqual([]);
    expect(target.blobs.has("image:restored-1")).toBe(true);
  });

  test("round trips video and audio assets through protected media storage", async () => {
    const sourceSnapshot = snapshot();
    const timestamp = "2026-07-18T00:00:00.000Z";
    sourceSnapshot.assets = [
      ...sourceSnapshot.assets,
      {
        id: "asset-video",
        kind: "video",
        title: "Demo video",
        tags: [],
        storageKey: "media:video",
        coverUrl: "/api/blobs/media%3Avideo",
        mimeType: "video/mp4",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "asset-audio",
        kind: "audio",
        title: "Demo audio",
        tags: [],
        storageKey: "media:audio",
        coverUrl: "/api/blobs/media%3Aaudio",
        mimeType: "audio/mpeg",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    const source = fakeStorage({
      "image:shared": new Blob(["image-bytes"], { type: "image/png" }),
      "media:video": new Blob(["video-bytes"], { type: "video/mp4" }),
      "media:audio": new Blob(["audio-bytes"], { type: "audio/mpeg" }),
    });

    const archive = await exportWorkspaceBundle(sourceSnapshot, source.storage);
    const target = fakeStorage();
    const restored = await importWorkspaceBundle(archive, createDefaultConfig(), target.storage);
    const video = restored.assets.find((asset) => asset.id === "asset-video");
    const audio = restored.assets.find((asset) => asset.id === "asset-audio");

    expect(target.stores()).toBe(3);
    expect(video).toMatchObject({ kind: "video", mimeType: "video/mp4" });
    expect(audio).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
    expect(video?.storageKey).toStartWith("media:");
    expect(audio?.storageKey).toStartWith("media:");
    expect(target.blobs.get(video!.storageKey!)).toEqual(new Blob(["video-bytes"], { type: "video/mp4" }));
    expect(target.blobs.get(audio!.storageKey!)).toEqual(new Blob(["audio-bytes"], { type: "audio/mpeg" }));
  });

  test("rejects disguised panorama media before restoring a workspace", async () => {
    const sourceSnapshot = snapshot();
    sourceSnapshot.projects[0]!.nodes.push(createNode("panorama", { x: 400, y: 20 }, {
      metadata: {
        content: "/api/blobs/image%3Apanorama",
        storageKey: "image:panorama",
        naturalWidth: 2048,
        naturalHeight: 1024,
        mimeType: "image/png",
        panoramaProjection: "equirectangular",
      },
    }));
    const source = fakeStorage({
      "image:shared": new Blob([pngHeader], { type: "image/png" }),
      "image:panorama": new Blob(["disguised workspace payload"], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(sourceSnapshot, source.storage);

    await expect(importWorkspaceBundle(archive, createDefaultConfig(), fakeStorage().storage))
      .rejects.toThrow("声明格式");
  });

  test("rejects inline panorama content outside the workspace manifest", async () => {
    const sourceSnapshot = snapshot();
    sourceSnapshot.projects[0]!.nodes.push(createNode("panorama", { x: 400, y: 20 }, {
      metadata: {
        content: "data:image/png;base64,AAAA",
        naturalWidth: 2048,
        naturalHeight: 1024,
        mimeType: "image/png",
        panoramaProjection: "equirectangular",
      },
    }));
    const source = fakeStorage({
      "image:shared": new Blob([pngHeader], { type: "image/png" }),
    });
    const archive = await exportWorkspaceBundle(sourceSnapshot, source.storage);

    await expect(importWorkspaceBundle(archive, createDefaultConfig(), fakeStorage().storage))
      .rejects.toThrow("manifest");
  });
});
