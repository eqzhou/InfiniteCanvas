import { describe, expect, test } from "bun:test";

import { createFilmDocument } from "@/lib/film-document";
import { createDefaultConfig, createProject } from "@/lib/defaults";
import type { WorkspaceSnapshot } from "@/lib/workspace-bundle";
import {
  collectNonFilmStorageKeys,
  importCompleteProjectBundleWithDependencies,
  importCompleteWorkspaceBundleWithDependencies,
  prepareFilmRestore,
} from "./film-bundle";

function dependencies(events: string[], options: { fail?: Error; retained?: string[]; cleanupFail?: Error } = {}) {
  const project = createProject("Imported film", "film");
  const film = createFilmDocument(project.id, "2026-08-08T00:00:00.000Z");
  film.shots = [{ id: "shot-1", revision: 1, sceneId: "scene-1", order: 0, title: "Shot", description: "Action", status: "approved", durationSeconds: 1, aspectRatio: "16:9", identityVersionIds: [], videoStorageKey: "media:shot" }];
  film.assets = [{ id: "asset-1", revision: 1, kind: "style", title: "Look", description: "", status: "approved", mediaStorageKey: "image:asset" }];
  film.tasks = [{ id: "task-1", revision: 1, stage: "video", title: "Video", status: "needs_review", progress: 1, generationJobId: "job-1", shotId: "shot-1", requestHash: "request", createdAt: film.createdAt, updatedAt: film.updatedAt }];
  film.timeline.tracks[0]!.clips = [{ id: "clip-1", revision: 1, source: "media:timeline", order: 0, start: 0, end: 1, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }];
  film.deliverables = [{ id: "delivery-1", revision: 1, kind: "mp4", title: "Master", status: "approved", mimeType: "video/mp4", storageKey: "media:delivery", bytes: 10, createdAt: film.createdAt }];
  return {
    readBundle: async () => ({
      project,
      film,
      media: [
        { storageKey: "media:shot", mimeType: "video/mp4", bytes: 4, sha256: "a".repeat(64), objectVersion: `m1-${"b".repeat(64)}` },
        { storageKey: "image:asset", mimeType: "image/png", bytes: 5, sha256: "e".repeat(64), objectVersion: `m1-${"f".repeat(64)}` },
        { storageKey: "media:timeline", mimeType: "video/mp4", bytes: 6, sha256: "1".repeat(64), objectVersion: `m1-${"2".repeat(64)}` },
        { storageKey: "media:delivery", mimeType: "video/mp4", bytes: 10, sha256: "c".repeat(64), objectVersion: `m1-${"d".repeat(64)}` },
      ],
      cleanup: async () => { events.push("cleanup-media"); },
      cleanupMigrated: async (keys: readonly string[]) => {
        events.push(`cleanup-migrated:${[...keys].sort().join(",")}`);
        if (options.cleanupFail) throw options.cleanupFail;
      },
    }),
    prepareProject: (value: typeof project) => ({ ...value, id: "imported-film" }),
    commitImport: async (input: { project: typeof project; film?: { document: typeof film; media: unknown[] } }) => {
      events.push("transaction-project");
      if (options.fail) throw options.fail;
      expect(input.film?.document.shots[0]?.videoStorageKey).toBe("media:shot");
      expect(input.film?.document.tasks).toEqual(film.tasks);
      expect(input.film?.document.assets[0]?.mediaStorageKey).toBe("image:asset");
      expect(input.film?.document.timeline.tracks[0]?.clips[0]?.source).toBe("media:timeline");
      expect(input.film?.document.deliverables[0]?.storageKey).toBe("media:delivery");
      expect(input.film?.media).toHaveLength(4);
      return {
        project: input.project,
        film: input.film?.document,
        migratedStorageKeys: ["media:shot", "media:delivery", "image:asset", "media:timeline"],
      };
    },
    adoptProject: () => { events.push("adopt-project"); },
    retainedStorageKeys: async () => new Set(options.retained ?? []),
  };
}

describe("complete film bundle rollback", () => {
  test("builds strict metadata for timeline-only music, sound effects, and video", () => {
    const film = createFilmDocument("timeline-only", "2026-08-08T00:00:00.000Z");
    film.timeline.tracks = [
      { id: "music", revision: 1, kind: "music", title: "Music", clips: [{ id: "music-clip", revision: 1, source: "media:music", order: 0, start: 0, end: 1, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }] },
      { id: "sfx", revision: 1, kind: "sfx", title: "SFX", clips: [{ id: "sfx-clip", revision: 1, source: "media:sfx", order: 0, start: 0, end: 1, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }] },
      { id: "video", revision: 1, kind: "video", title: "Video", clips: [{ id: "video-clip", revision: 1, source: "media:video", order: 0, start: 0, end: 1, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }] },
    ];
    const imported = [
      { storageKey: "media:music", mimeType: "audio/mpeg", bytes: 1, sha256: "1".repeat(64), objectVersion: "music-v1" },
      { storageKey: "media:sfx", mimeType: "audio/wav", bytes: 2, sha256: "2".repeat(64), objectVersion: "sfx-v1" },
      { storageKey: "media:video", mimeType: "video/mp4", bytes: 3, sha256: "3".repeat(64), objectVersion: "video-v1" },
    ];

    const restore = prepareFilmRestore(film, imported);

    expect(restore.media.map((item) => item.provenance[0])).toEqual([
      { kind: "timeline", entityId: "music-clip", field: "source" },
      { kind: "timeline", entityId: "sfx-clip", field: "source" },
      { kind: "timeline", entityId: "video-clip", field: "source" },
    ]);
    expect(restore.document.timeline).toEqual(film.timeline);
  });

  test("deduplicates shared Film media and reports every exact provenance", () => {
    const film = createFilmDocument("shared-film", "2026-08-08T00:00:00.000Z");
    film.shots = [{ id: "shot-1", revision: 1, sceneId: "scene-1", order: 0, title: "Shot", description: "Action", status: "approved", durationSeconds: 1, aspectRatio: "16:9", identityVersionIds: [], imageStorageKey: "image:shared" }];
    film.assets = [{ id: "asset-1", revision: 1, kind: "style", title: "Style", description: "", status: "approved", mediaStorageKey: "image:shared" }];
    film.timeline.tracks = [{ id: "video", revision: 1, kind: "video", title: "Video", clips: [{ id: "clip-1", revision: 1, source: "image:shared", order: 0, start: 0, end: 1, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }] }];
    const imported = [{ storageKey: "image:shared", mimeType: "image/png", bytes: 5, sha256: "a".repeat(64), objectVersion: "shared-v1" }];

    const restore = prepareFilmRestore(film, imported);

    expect(restore.media).toHaveLength(1);
    expect(restore.media[0]?.provenance).toEqual([
      { kind: "shot", entityId: "shot-1", field: "imageStorageKey" },
      { kind: "asset", entityId: "asset-1", field: "mediaStorageKey" },
      { kind: "timeline", entityId: "clip-1", field: "source" },
    ]);
    expect(restore.document.shots[0]).toMatchObject({ imageSha256: "a".repeat(64), imageObjectVersion: "shared-v1" });
    expect(restore.document.assets[0]).toMatchObject({ mediaSha256: "a".repeat(64), mediaObjectVersion: "shared-v1" });
  });

  test("preserves dialogue and frozen task snapshot media identities", () => {
    const film = createFilmDocument("nested-film", "2026-08-08T00:00:00.000Z");
    const asset = { id: "identity-1", revision: 1, kind: "identity" as const, title: "Identity", description: "", status: "approved" as const, mediaStorageKey: "image:nested" };
    film.dialogues = [{ id: "dialogue-1", revision: 1, shotId: "shot-1", order: 0, kind: "narration", text: "Line", status: "approved", audioStorageKey: "media:dialogue" }];
    film.tasks = [{ id: "task-1", revision: 1, stage: "storyboard", title: "Task", status: "needs_review", progress: 1, createdAt: film.createdAt, updatedAt: film.updatedAt, snapshot: { shotRevision: 1, prompt: "Prompt", providerId: "provider", model: "model", config: {}, identityVersions: [asset], styleVersion: { ...asset, id: "style-1", kind: "style" }, referenceStorageKeys: ["image:nested"], estimatedGenerations: 1, createdAt: film.createdAt } }];
    const imported = [
      { storageKey: "image:nested", mimeType: "image/png", bytes: 5, sha256: "a".repeat(64), objectVersion: "image-v1" },
      { storageKey: "media:dialogue", mimeType: "audio/mpeg", bytes: 4, sha256: "b".repeat(64), objectVersion: "audio-v1" },
    ];

    const restore = prepareFilmRestore(film, imported);

    expect(restore.media[0]?.provenance).toEqual([
      { kind: "task", entityId: "task-1", field: "identity:identity-1" },
      { kind: "task", entityId: "task-1", field: "style" },
      { kind: "task", entityId: "task-1", field: "reference:0" },
    ]);
    expect(restore.media[1]?.provenance).toEqual([{ kind: "dialogue", entityId: "dialogue-1", field: "audioStorageKey" }]);
    expect(restore.document.tasks[0]?.snapshot?.identityVersions[0]).toMatchObject({ mediaSha256: "a".repeat(64), mediaObjectVersion: "image-v1" });
    expect(restore.document.dialogues?.[0]).toMatchObject({ audioSha256: "b".repeat(64), audioObjectVersion: "audio-v1" });
  });

  test("keeps migrated Film sources that remain referenced outside Film", () => {
    const project = createProject("Shared", "film");
    project.nodes = [{ id: "node-1", type: "image", title: "Shared", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { storageKey: "image:shared" } }];
    const snapshot: WorkspaceSnapshot = {
      projects: [project],
      assets: [{ id: "asset-shared", name: "Shared", kind: "image", storageKey: "image:asset-shared", coverUrl: "", createdAt: project.createdAt }],
      prompts: [], config: createDefaultConfig(), workflowTemplates: [],
      generationJobs: [{ id: "job-shared", kind: "image", status: "succeeded", prompt: "shared", parameters: { referenceStorageKeys: ["image:job-shared"] }, result: {}, createdAt: project.createdAt, updatedAt: project.updatedAt }],
    };

    expect(collectNonFilmStorageKeys(snapshot)).toEqual(new Set(["image:shared", "image:asset-shared", "image:job-shared"]));
  });
  test("commits a complete project bundle atomically and cleans only unshared migrated uploads", async () => {
    const events: string[] = [];

    await importCompleteProjectBundleWithDependencies(new Uint8Array(), dependencies(events, { retained: ["media:shot"] }));

    expect(events).toEqual(["transaction-project", "adopt-project", "cleanup-migrated:image:asset,media:delivery,media:timeline"]);
  });

  test("project transaction failure leaves no adopted project or tombstone cleanup", async () => {
    const events: string[] = [];

    await expect(importCompleteProjectBundleWithDependencies(
      new Uint8Array(),
      dependencies(events, { fail: new Error("atomic import rejected") }),
    )).rejects.toThrow("atomic import rejected");

    expect(events).toEqual(["transaction-project", "cleanup-media"]);
  });

  test("does not delete committed media when redundant-source cleanup fails", async () => {
    const events: string[] = [];

    await expect(importCompleteProjectBundleWithDependencies(
      new Uint8Array(),
      dependencies(events, { cleanupFail: new Error("cleanup unavailable") }),
    )).resolves.toBe("imported-film");

    expect(events).toEqual([
      "transaction-project",
      "adopt-project",
      "cleanup-migrated:image:asset,media:delivery,media:shot,media:timeline",
    ]);
  });

  test("submits multiple films in one workspace transaction and keeps the old workspace on failure", async () => {
    const events: string[] = [];
    const firstProject = createProject("First film", "film");
    const secondProject = createProject("Second film", "film");
    const firstFilm = createFilmDocument(firstProject.id, "2026-08-08T00:00:00.000Z");
    const secondFilm = createFilmDocument(secondProject.id, "2026-08-08T00:00:00.000Z");
    const config = createDefaultConfig();
    const imported: WorkspaceSnapshot = { projects: [firstProject, secondProject], assets: [], prompts: [], config, generationJobs: [], workflowTemplates: [], films: [firstFilm, secondFilm] };
    let adopted = false;

    await expect(importCompleteWorkspaceBundleWithDependencies(new Uint8Array(), config, undefined, {
      importWorkspace: async (_source, _config, _storage, apply) => {
        try { return await apply?.(imported, { media: [], cleanupMigrated: async () => {} }) ?? imported; }
        catch (cause) { events.push("cleanup-media"); throw cause; }
      },
      loadFilm: async (projectId) => ({ document: projectId === firstProject.id ? firstFilm : secondFilm, recordRevision: 4, capabilities: {} as never }),
      commitWorkspace: async (input) => {
        events.push(`transaction-films:${input.films.map((item) => item.document.projectId).join(",")}`);
        throw new Error("second film failed");
      },
      adoptWorkspace: () => { adopted = true; },
    })).rejects.toThrow("second film failed");

    expect(adopted).toBe(false);
    expect(events).toEqual([`transaction-films:${firstProject.id},${secondProject.id}`, "cleanup-media"]);
  });

  test("keeps a committed workspace when migrated-source cleanup fails", async () => {
    const events: string[] = [];
    const project = createProject("Committed film", "film");
    const film = createFilmDocument(project.id, "2026-08-08T00:00:00.000Z");
    const config = createDefaultConfig();
    const imported: WorkspaceSnapshot = { projects: [project], assets: [], prompts: [], config, generationJobs: [], workflowTemplates: [], films: [film] };

    const result = await importCompleteWorkspaceBundleWithDependencies(new Uint8Array(), config, undefined, {
      importWorkspace: async (_source, _config, _storage, apply) => {
        try {
          return await apply?.(imported, {
            media: [],
            cleanupMigrated: async () => { events.push("cleanup-migrated"); throw new Error("cleanup unavailable"); },
          }) ?? imported;
        } catch (cause) {
          events.push("cleanup-media");
          throw cause;
        }
      },
      loadFilm: async () => ({ document: film, recordRevision: 2, capabilities: {} as never }),
      commitWorkspace: async () => ({
        version: `w1-${"a".repeat(64)}`, restoreToken: "token", migratedStorageKeys: ["media:migrated"],
      }),
      adoptWorkspace: () => { events.push("adopt-workspace"); },
    });

    expect(result.films).toEqual([film]);
    expect(events).toEqual(["adopt-workspace", "cleanup-migrated"]);
  });

  test("uses workspace migration receipts and sends all metadata before local adoption", async () => {
    const events: string[] = [];
    const project = createProject("Receipt film", "film");
    const film = createFilmDocument(project.id, "2026-08-08T00:00:00.000Z");
    film.timeline.tracks[0]!.clips = [{ id: "timeline-only", revision: 1, source: "media:timeline", order: 0, start: 0, end: 1, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }];
    const config = createDefaultConfig();
    const imported: WorkspaceSnapshot = { projects: [project], assets: [], prompts: [], config, generationJobs: [], workflowTemplates: [], films: [film] };
    const media = [{ storageKey: "media:timeline", mimeType: "audio/mpeg", bytes: 4, sha256: "a".repeat(64), objectVersion: "timeline-v1" }];

    await importCompleteWorkspaceBundleWithDependencies(new Uint8Array(), config, undefined, {
      importWorkspace: async (_source, _config, _storage, apply) => {
        return await apply?.(imported, {
          media,
          cleanupMigrated: async (keys) => { events.push(`cleanup:${keys.join(",")}`); },
        }) ?? imported;
      },
      loadFilm: async () => ({ document: film, recordRevision: 3, capabilities: {} as never }),
      commitWorkspace: async (input) => {
        expect(input.snapshot).toEqual({ ...imported, films: undefined });
        expect(input.films[0]?.media[0]?.provenance).toEqual([
          { kind: "timeline", entityId: "timeline-only", field: "source" },
        ]);
        events.push("transaction");
        return { version: `w1-${"a".repeat(64)}`, restoreToken: "restore-token", migratedStorageKeys: ["media:timeline"] };
      },
      adoptWorkspace: () => { events.push("adopt-workspace"); },
    });

    expect(events).toEqual(["transaction", "adopt-workspace", "cleanup:media:timeline"]);
  });
});
