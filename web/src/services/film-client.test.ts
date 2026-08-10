import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  importFilmManuscriptFile,
  resolveFilmStageSelection,
  listFilmGenerationJobs,
  loadFilmCapabilities,
  loadFilmStatus,
  normalizeFilmCapabilities,
  requestFilmStageRun,
  requestFilmAIDecomposition,
  applyFilmAICandidate,
  requestFilmExport,
  retryFilmGenerationJob,
  waitForFilmGenerationStage,
  refreshFilmProjection,
  commitFilmProjection,
  adoptFilmCanvasMedia,
  restoreFilmProduction,
  updateFilmAsset,
} from "./film-client";
import { createFilmDocument } from "@/lib/film-document";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("film client", () => {
  test("loads a bounded film response through authenticated API routing", async () => {
    const fetcher = mock(async (url: RequestInfo | URL) => new Response(JSON.stringify({
      data: {
        schemaVersion: 1, projectId: "film-1", revision: 1,
        episodes: [], shots: [], assets: [], timeline: { revision: 1, tracks: [] },
      },
      meta: { recordRevision: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetcher as typeof fetch;

    const status = await loadFilmStatus("film-1");

    expect(status.document.projectId).toBe("film-1");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/projects/film-1/status");
  });

  test("rejects unsafe project ids before a network request", async () => {
    await expect(loadFilmStatus("../other")).rejects.toThrow("Invalid");
  });

  test("loads feature availability without exposing an executable path", async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ data: {
      available: true, reason: "", mp4Export: false, mp4Diagnostic: "MP4 export is disabled",
    } }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;

    const capability = await loadFilmCapabilities();

    expect(capability.mp4Export).toBe(false);
    expect(capability.mp4Diagnostic).toBe("MP4 export is disabled");
    expect(capability.plainTextImport).toBe(true);
    expect(capability.docxImport).toBe(false);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/capabilities");
  });

  test("normalizes legacy status capabilities into conservative feature flags", () => {
    expect(normalizeFilmCapabilities({
      plainTextImport: true,
      markdownImport: true,
      docxImport: false,
      pdfImport: false,
      mp4Export: false,
      mp4Diagnostic: "renderer unavailable",
    })).toMatchObject({
      plainTextImport: true,
      markdownImport: true,
      docxImport: false,
      pdfImport: false,
      fileUploadImport: false,
      stageGeneration: false,
      generationJobs: false,
      assetBundleExport: false,
      mp4Export: false,
    });
  });

  test("normalizes the backend generation-stage capability map without enabling unavailable stages", () => {
    expect(normalizeFilmCapabilities({
      stageGeneration: true,
      generationStages: { storyboard: false, audio: false, video: true },
    } as never).generationStages).toEqual(["video"]);
  });

  test.each([
    ["docx", "draft.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["pdf", "draft.pdf", "application/pdf"],
  ] as const)("uploads %s manuscripts with only the server multipart fields", async (format, name, mimeType) => {
    const film = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const fetcher = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
      const body = init?.body as FormData;
      expect([...body.keys()].sort()).toEqual(["file", "revision"]);
      expect((body.get("file") as File).name).toBe(name);
      expect((body.get("file") as File).type).toBe(mimeType);
      return new Response(JSON.stringify({ data: film, meta: { recordRevision: 2 } }), { status: 200 });
    });
    globalThis.fetch = fetcher as typeof fetch;

    await importFilmManuscriptFile("film-1", {
      revision: 0,
      format,
      file: new File(["fixture"], name, { type: mimeType }),
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/projects/film-1/source/import");
  });

  test("resolves one-based episode positions to explicit shot ids and zero-based shot orders", () => {
    const film = createFilmDocument("film-selection", "2026-08-08T00:00:00.000Z");
    film.episodes = [
      { id: "ep-a", revision: 1, order: 0, title: "A", synopsis: "", status: "draft" },
      { id: "ep-b", revision: 1, order: 1, title: "B", synopsis: "", status: "draft" },
    ];
    film.scenes = [
      { id: "scene-a", revision: 1, episodeId: "ep-a", order: 0, heading: "A", synopsis: "", status: "draft" },
      { id: "scene-b", revision: 1, episodeId: "ep-b", order: 0, heading: "B", synopsis: "", status: "draft" },
    ];
    film.shots = [
      { id: "shot-a0", revision: 1, sceneId: "scene-a", order: 0, title: "A0", description: "A0", status: "draft", durationSeconds: 1, aspectRatio: "16:9", identityVersionIds: [] },
      { id: "shot-a1", revision: 1, sceneId: "scene-a", order: 1, title: "A1", description: "A1", status: "draft", durationSeconds: 1, aspectRatio: "16:9", identityVersionIds: [] },
      { id: "shot-b0", revision: 1, sceneId: "scene-b", order: 0, title: "B0", description: "B0", status: "draft", durationSeconds: 1, aspectRatio: "16:9", identityVersionIds: [] },
    ];

    expect(resolveFilmStageSelection(film, { from: 2, to: 2 }, { from: 0, to: 0 })).toEqual({ shotIds: ["shot-b0"] });
    expect(resolveFilmStageSelection(film, undefined, undefined)).toEqual({ shotRange: { from: 0, to: 0 } });
  });

  test("sends only the accepted stage generation fields", async () => {
    const film = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const fetcher = mock(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
      data: film, meta: { recordRevision: 2 },
    }), { status: 202 }));
    globalThis.fetch = fetcher as typeof fetch;

    await requestFilmStageRun("film-1", "video", {
      revision: 1,
      shotIds: ["shot-3", "shot-8"],
      provider: "studio-provider",
      model: "video-v2",
      generationConfig: { resolution: "1080p", seed: 7 },
      idempotencyKey: "film-video-0001",
    });

    const init = fetcher.mock.calls[0]?.[1];
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/projects/film-1/stages/video/run");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("film-video-0001");
    expect(JSON.parse(String(init?.body))).toEqual({ revision: 1, shotIds: ["shot-3", "shot-8"], providerId: "studio-provider", model: "video-v2", config: { resolution: "1080p" }, idempotencyKey: "film-video-0001" });
  });

  test("sends strict AI decomposition and candidate apply contracts", async () => {
    const film = createFilmDocument("film-ai", "2026-08-08T00:00:00.000Z");
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ data: film, meta: { recordRevision: 2 } }), { status: 202 });
    }) as typeof fetch;

    await requestFilmAIDecomposition("film-ai", {
      revision: 3, providerId: "shared-text", model: "gpt-text", idempotencyKey: "decompose-1",
    });
    await applyFilmAICandidate("film-ai", "candidate-1", 4);

    expect(requests[0]).toEqual({
      url: "/api/film/projects/film-ai/stages/decompose/run",
      body: { revision: 3, mode: "ai", providerId: "shared-text", model: "gpt-text", idempotencyKey: "decompose-1" },
    });
    expect(requests[1]).toEqual({
      url: "/api/film/projects/film-ai/ai-candidates/candidate-1/apply",
      body: { revision: 4 },
    });
  });

  test("sends a stable idempotency key for every export kind", async () => {
    const film = createFilmDocument("film-export", "2026-08-08T00:00:00.000Z");
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: film, meta: { recordRevision: 4 } }), { status: 202 });
    }) as typeof fetch;

    for (const kind of ["mp4", "srt", "manifest", "asset_bundle"] as const) await requestFilmExport("film-export", kind, 3);
    await requestFilmExport("film-export", "mp4", 3);

    expect(bodies.slice(0, 4).map((body) => body.kind)).toEqual(["mp4", "srt", "manifest", "asset_bundle"]);
    expect(bodies.every((body) => typeof body.idempotencyKey === "string" && String(body.idempotencyKey).length > 0)).toBe(true);
    expect(bodies[4]?.idempotencyKey).toBe(bodies[0]?.idempotencyKey);
    expect(new Set(bodies.slice(0, 4).map((body) => body.idempotencyKey)).size).toBe(4);
  });

  test("preserves discovered capabilities when a mutation omits them", async () => {
    const film = createFilmDocument("film-cap-cache", "2026-08-08T00:00:00.000Z");
    let call = 0;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      data: film,
      meta: { recordRevision: ++call },
      ...(call === 1 ? { capabilities: { stageGeneration: true, generationJobs: true, mp4Export: true } } : {}),
    }), { status: 200 })) as typeof fetch;

    expect((await loadFilmStatus("film-cap-cache")).capabilities.mp4Export).toBe(true);
    expect((await updateFilmAsset("film-cap-cache", "asset-1", { revision: 1, title: "v2" })).capabilities).toMatchObject({ stageGeneration: true, generationJobs: true, mp4Export: true });
  });

  test("syncs a stage after real generation jobs reach a terminal state", async () => {
    const film = createFilmDocument("film-poll", "2026-08-08T00:00:00.000Z");
    const sync = mock(async () => ({ document: film, recordRevision: 3, capabilities: normalizeFilmCapabilities({ generationJobs: true }) }));
    const result = await waitForFilmGenerationStage("film-poll", "video", {
      maxPolls: 2,
      intervalMs: 0,
      loadStatus: async () => ({ document: film, recordRevision: 2, capabilities: normalizeFilmCapabilities({ generationJobs: true }) }),
      listJobs: async () => [{ id: "job-1", shotId: "shot-1", stage: "video", status: "needs_review", title: "Shot", createdAt: film.createdAt, updatedAt: film.updatedAt }],
      sync,
    });

    expect(result.recordRevision).toBe(3);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  test("bounds and cancels generation polling", async () => {
    const film = createFilmDocument("film-poll-limit", "2026-08-08T00:00:00.000Z");
    const status = { document: film, recordRevision: 1, capabilities: normalizeFilmCapabilities({ generationJobs: true }) };
    const listJobs = async () => [{ id: "job-1", shotId: "shot-1", stage: "video" as const, status: "running" as const, title: "Shot", createdAt: film.createdAt, updatedAt: film.updatedAt }];
    await expect(waitForFilmGenerationStage("film-poll-limit", "video", { maxPolls: 2, intervalMs: 0, loadStatus: async () => status, listJobs })).rejects.toThrow("polling limit");
    const controller = new AbortController(); controller.abort();
    await expect(waitForFilmGenerationStage("film-poll-limit", "video", { signal: controller.signal, loadStatus: async () => status, listJobs })).rejects.toThrow("aborted");
  });

  test("retries a failed shot through the mounted stage-run fallback", async () => {
    const film = createFilmDocument("film-retry", "2026-08-08T00:00:00.000Z");
    film.shots = [{ id: "shot-1", revision: 1, sceneId: "scene-1", order: 0, title: "Shot", description: "Action", status: "failed", durationSeconds: 1, aspectRatio: "16:9", identityVersionIds: [] }];
    film.tasks = [{ id: "task-1", revision: 1, stage: "video", title: "Video", status: "failed", progress: 0, generationJobId: "job-1", shotId: "shot-1", createdAt: film.createdAt, updatedAt: film.updatedAt }];
    let runBody: Record<string, unknown> | undefined;
    globalThis.fetch = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/generation-jobs/job-1/retry")) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
      if (path.endsWith("/status")) return new Response(JSON.stringify({ data: film, meta: { recordRevision: 3 } }), { status: 200 });
      if (path.endsWith("/api/generation-jobs/job-1")) return new Response(JSON.stringify({
        id: "job-1", projectId: "film-retry", kind: "video", status: "failed", prompt: "Action",
        providerId: "provider-1", model: "video-v2", parameters: { executor: "server", resolution: "1080p", seconds: 4 },
        result: {}, createdAt: film.createdAt, updatedAt: film.updatedAt,
      }), { status: 200 });
      if (path.endsWith("/stages/video/run")) {
        runBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: film, meta: { recordRevision: 4 } }), { status: 202 });
      }
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    const result = await retryFilmGenerationJob("film-retry", "job-1");

    expect("document" in result).toBe(true);
    expect(runBody).toMatchObject({ shotIds: ["shot-1"], providerId: "provider-1", model: "video-v2", config: { resolution: "1080p", seconds: 4 } });
    expect(runBody).not.toHaveProperty("config.executor");
  });

  test("normalizes parent and shot generation jobs without treating success as approval", async () => {
    const film = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    film.tasks = [{ id: "task-1", revision: 1, stage: "video", title: "Film video task", status: "needs_review", progress: 1, generationJobId: "child-1", shotId: "shot-1", createdAt: film.createdAt, updatedAt: film.updatedAt }];
    const fetcher = mock(async () => new Response(JSON.stringify({ data: [
      { id: "parent-1", stage: "video", status: "running", title: "Video pass", createdAt: "2026-08-08T00:00:00Z", updatedAt: "2026-08-08T00:00:00Z" },
      { id: "child-1", parentJobId: "parent-1", shotId: "shot-1", stage: "video", status: "succeeded", title: "Shot 1", createdAt: "2026-08-08T00:00:00Z", updatedAt: "2026-08-08T00:00:00Z" },
    ] }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;

    const jobs = await listFilmGenerationJobs("film-1", { document: film, recordRevision: 1, capabilities: normalizeFilmCapabilities({ generationJobs: true }) });

    expect(jobs.map((job) => job.status)).toEqual(["running", "needs_review"]);
    expect(jobs[0]).toMatchObject({ id: "parent-1", title: "Video pass" });
    expect(jobs[1]).toMatchObject({ shotId: "shot-1", parentJobId: "parent-1" });
  });

  test("parses the generation-jobs hierarchy contract without treating HTTP 200 data as an array", async () => {
    const film = createFilmDocument("film-contract", "2026-08-08T00:00:00.000Z");
    const task = {
      id: "task-contract", revision: 2, stage: "video" as const, title: "Video parent",
      status: "running" as const, progress: 0.5, generationJobId: "job-contract", shotId: "shot-contract",
      requestHash: "request-contract", createdAt: film.createdAt, updatedAt: film.updatedAt,
    };
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ data: {
      tasks: [task],
      generationJobs: [{
        id: "job-contract", parentJobId: "task-contract", shotId: "shot-contract", stage: "video",
        status: "running", title: "Shot child", progress: 0.5,
        createdAt: film.createdAt, updatedAt: film.updatedAt,
      }],
    } }), { status: 200 })) as typeof fetch;

    const jobs = await listFilmGenerationJobs("film-contract");

    expect(jobs).toEqual([
      {
        id: "task-contract", stage: "video", status: "running", title: "Video parent", progress: 0.5,
        createdAt: film.createdAt, updatedAt: film.updatedAt,
      },
      {
        id: "job-contract", parentJobId: "task-contract", shotId: "shot-contract", stage: "video",
        status: "running", title: "Shot child", progress: 0.5,
        createdAt: film.createdAt, updatedAt: film.updatedAt,
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("updates versioned assets using compare-and-swap revision", async () => {
    const film = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const fetcher = mock(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: film, meta: { recordRevision: 2 },
    }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;

    await updateFilmAsset("film-1", "asset-1", {
      revision: 4,
      title: "Hero identity v2",
      parentAssetId: "character-1",
      stylePrompt: "cool dusk",
    });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ revision: 4, parentAssetId: "character-1" });
  });

  test("refreshes and commits the real server projection contract", async () => {
    const film = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const fetcher = mock(async (url: RequestInfo | URL) => String(url).endsWith("/projection/refresh")
      ? new Response(JSON.stringify({ data: {
        projectId: "film-1", recordRevision: 3, projectionRevision: 2,
        targets: [{ projectionKey: "shot:shot-1", revision: 4, type: "text", title: "Shot", content: "Wide" }],
      } }), { status: 200 })
      : new Response(JSON.stringify({ data: film, meta: { recordRevision: 4 } }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;

    const plan = await refreshFilmProjection("film-1");
    await commitFilmProjection("film-1", {
      projectionKey: plan.targets[0]!.projectionKey,
      expectedRevision: plan.targets[0]!.revision,
      fields: { title: "Committed shot" },
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/projects/film-1/projection/refresh");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/film/projects/film-1/projection/commit");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedRevision: 4 });
  });

  test("adopts canvas media with exact target and source provenance", async () => {
    const film = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const fetcher = mock(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: film, meta: { recordRevision: 4 } }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;
    await adoptFilmCanvasMedia("film-1", {
      targetType: "shot", targetId: "shot-1", targetField: "image", expectedRevision: 3,
      sourceNodeId: "node-1", storageKey: "image:candidate", generationJobId: "job-1",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/projects/film-1/projection/adopt");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ targetId: "shot-1", sourceNodeId: "node-1", generationJobId: "job-1" });
  });

  test("restores a film aggregate through the scoped create revision", async () => {
    const film = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const fetcher = mock(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
      data: film, meta: { recordRevision: 1 },
    }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;

    await restoreFilmProduction("film-1", film);

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/projects/film-1/restore");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ revision: 0, document: film });
  });

  test("sends the strict restore media contract and consumes migrated storage keys", async () => {
    const film = createFilmDocument("film-rehydrate", "2026-08-08T00:00:00.000Z");
    const rewritten = { ...film, deliverables: [{ id: "delivery-1", revision: 1, kind: "mp4" as const, status: "approved" as const, title: "Master", mimeType: "video/mp4", storageKey: "film:deliverable:film-rehydrate:delivery-1", bytes: 4, createdAt: film.createdAt }] };
    const fetcher = mock(async () => new Response(JSON.stringify({ data: rewritten, meta: { recordRevision: 2, rehydration: { migratedStorageKeys: ["media:temporary"] } } }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;
    const media = [{
      storageKey: "media:temporary", mimeType: "video/mp4", bytes: 4,
      sha256: "a".repeat(64), objectVersion: `m1-${"b".repeat(64)}`,
      provenance: [{ kind: "timeline" as const, entityId: "clip-1", field: "source" as const }],
    }];
    const result = await restoreFilmProduction("film-rehydrate", film, 0, media);

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ revision: 0, document: film, media });
    expect(result.document.deliverables[0]?.storageKey).toStartWith("film:deliverable:film-rehydrate:");
    expect(result.rehydration?.migratedStorageKeys).toEqual(["media:temporary"]);
  });
});
