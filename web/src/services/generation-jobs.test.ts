import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  collectGenerationStorageKeysFromJobs,
  collectGenerationStorageKeys,
  createGenerationJob,
  createServerAudioGenerationJob,
  createServerImageGenerationJob,
  createServerVideoGenerationJob,
  cancelServerGenerationJob,
  deleteGenerationJob,
  deleteGenerationJobs,
  deleteGenerationJobsForProject,
  findInterruptedGenerationJobs,
  failGenerationJobIfUnchanged,
  findUnreferencedGenerationStorageKeys,
  getGenerationJob,
  generationRequestError,
  isServerOwnedGenerationJob,
  generationJobListExhausted,
  listGenerationJobs,
  listAllGenerationJobs,
  paginateGenerationJobs,
  replaceGenerationJobs,
  selectGenerationJobsForNodeCleanup,
  selectGenerationJobsForProject,
  uniqueGenerationJobIds,
  updateGenerationJob,
  usesBrowserE2EGeneration,
  usesServerGenerationJobs,
  validateGenerationJob,
  waitForGenerationJob,
} from "./generation-jobs";
import {
  WORKBENCH_ALL_CATEGORIES,
  WORKBENCH_ALL_CATEGORIES_LABEL,
} from "@/lib/workbench-history";
import type { GenerationJob } from "@/types/board";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function responseFor(jobValue: GenerationJob): Response {
  return new Response(JSON.stringify(jobValue), { headers: { "Content-Type": "application/json" } });
}

function pageFor(items: GenerationJob[], page = 1, total = items.length): Response {
  return new Response(JSON.stringify({ items, page, pageSize: 100, total }), {
    headers: { "Content-Type": "application/json" },
  });
}

const job = (id: string, createdAt: string, kind: GenerationJob["kind"] = "image"): GenerationJob => ({
  id,
  kind,
  status: "succeeded",
  prompt: id,
  parameters: {},
  result: {},
  createdAt,
  updatedAt: createdAt,
});

describe("generation job pagination", () => {
  test("accepts durable Film text jobs in the shared task contract", () => {
    const parsed = validateGenerationJob({
      ...job("film-text", "2026-08-11T00:00:00.000Z"),
      kind: "text",
      parameters: { executor: "server", operation: "film_decompose" },
    });
    expect(parsed.kind).toBe("text");
  });

  test("accepts durable Film stage parent jobs in the shared task contract", () => {
    const parsed = validateGenerationJob({
      ...job("film-parent", "2026-08-11T00:00:00.000Z"),
      projectId: "film-project-1",
      kind: "film-stage",
      status: "running",
      prompt: "",
      parameters: { film: { stage: "storyboard" } },
    });
    expect(parsed.kind).toBe("film-stage");
  });

  test("surfaces the server's refusal reason instead of a bare status", () => {
    // A tenant allow-list refusal explains what to change; collapsing it to
    // "HTTP 403" leaves the user with no idea why generation was blocked.
    expect(generationRequestError(403, "model is not in the tenant allow list").message)
      .toContain("model is not in the tenant allow list");
    expect(generationRequestError(403, "cloud channel generation disabled by admin").message)
      .toContain("cloud channel generation disabled by admin");
    const gone = generationRequestError(410, "generation job was deleted") as Error & { status?: number };
    expect(gone.status).toBe(410);
  });

  test("falls back to the status when the body carries no usable reason", () => {
    expect(generationRequestError(500, "").message).toContain("500");
    // An HTML error page or an oversized body is not a reason worth showing.
    expect(generationRequestError(502, "<!doctype html><html>...</html>").message).toContain("502");
    expect(generationRequestError(503, "x".repeat(1000)).message.length).toBeLessThan(400);
  });

  test("stops listing when the page is short, complete, or missing a total", () => {
    expect(generationJobListExhausted(1, 100, 3, Number.NaN)).toBe(true);
    expect(generationJobListExhausted(1, 100, 100, 250)).toBe(false);
    expect(generationJobListExhausted(3, 100, 100, 250)).toBe(true);
    expect(generationJobListExhausted(1, 0, 100, 500)).toBe(true);
  });

  test("filters, sorts newest first, paginates, and leaves input immutable", () => {
    const input = [
      job("old", "2026-07-01T00:00:00Z"),
      job("video", "2026-07-03T00:00:00Z", "video"),
      job("audio", "2026-07-03T01:00:00Z", "audio"),
      job("new", "2026-07-02T00:00:00Z"),
    ];
    const page = paginateGenerationJobs(input, { kind: "image", page: 1, pageSize: 1 });
    expect(page.items.map((item) => item.id)).toEqual(["new"]);
    expect(page.total).toBe(2);
    expect(input.map((item) => item.id)).toEqual(["old", "video", "audio", "new"]);
  });

  test("applies the same grouped status filters as the server", () => {
    const input = [
      { ...job("succeeded", "2026-07-01T00:00:00Z"), status: "succeeded" as const },
      { ...job("running", "2026-07-02T00:00:00Z"), status: "running" as const },
      { ...job("queued", "2026-07-03T00:00:00Z"), status: "queued" as const },
      { ...job("failed", "2026-07-04T00:00:00Z"), status: "failed" as const },
      { ...job("cancelled", "2026-07-05T00:00:00Z"), status: "cancelled" as const },
    ];
    expect(paginateGenerationJobs(input, { status: "succeeded", page: 1, pageSize: 20 }).items.map(({ id }) => id))
      .toEqual(["queued", "running", "succeeded"]);
    expect(paginateGenerationJobs(input, { status: "failed", page: 1, pageSize: 20 }).items.map(({ id }) => id))
      .toEqual(["cancelled", "failed"]);
    expect(paginateGenerationJobs(input, { status: "all", page: 1, pageSize: 20 }).total).toBe(5);
  });

  test("applies the strict workbench category normalization before filtering", () => {
    const input = [
      { ...job("poster-spaced", "2026-07-01T00:00:00Z"), parameters: { category: "  海报  " } },
      { ...job("poster", "2026-07-02T00:00:00Z"), parameters: { category: "海报" } },
      { ...job("uncategorized-empty", "2026-07-03T00:00:00Z"), parameters: { category: " " } },
      { ...job("uncategorized-missing", "2026-07-04T00:00:00Z") },
      { ...job("uncategorized-oversized", "2026-07-05T00:00:00Z"), parameters: { category: "x".repeat(101) } },
    ];
    expect(paginateGenerationJobs(input, { category: " 海报 ", page: 1, pageSize: 20 }).items.map(({ id }) => id))
      .toEqual(["poster", "poster-spaced"]);
    expect(paginateGenerationJobs(input, { category: "未分类", page: 1, pageSize: 20 }).items.map(({ id }) => id))
      .toEqual(["uncategorized-oversized", "uncategorized-missing", "uncategorized-empty"]);
    expect(paginateGenerationJobs([
      { ...job("literal-all", "2026-07-06T00:00:00Z"), parameters: { category: WORKBENCH_ALL_CATEGORIES_LABEL } },
      job("poster", "2026-07-05T00:00:00Z"),
    ], { category: WORKBENCH_ALL_CATEGORIES_LABEL, page: 1, pageSize: 20 }).items.map(({ id }) => id))
      .toEqual(["literal-all"]);
    expect(paginateGenerationJobs([
      { ...job("literal-all", "2026-07-06T00:00:00Z"), parameters: { category: WORKBENCH_ALL_CATEGORIES_LABEL } },
      job("poster", "2026-07-05T00:00:00Z"),
    ], { category: WORKBENCH_ALL_CATEGORIES, page: 1, pageSize: 20 }).total).toBe(2);
  });

  test("computes complete category metadata before category pagination", () => {
    const input = [
      { ...job("poster-old", "2026-07-01T00:00:00Z"), projectId: "board-a", parameters: { category: "海报" } },
      { ...job("character-new", "2026-07-04T00:00:00Z"), projectId: "board-a", parameters: { category: "角色" } },
      { ...job("failed-only", "2026-07-05T00:00:00Z"), projectId: "board-a", status: "failed" as const, parameters: { category: "失败专用" } },
      { ...job("foreign", "2026-07-06T00:00:00Z"), projectId: "board-b", parameters: { category: "其他画布" } },
      { ...job("video", "2026-07-07T00:00:00Z", "video"), projectId: "board-a", parameters: { category: "视频" } },
    ];
    const page = paginateGenerationJobs(input, {
      projectId: "board-a", kind: "image", status: "succeeded", category: "海报", page: 1, pageSize: 1,
    });
    expect(page.items.map(({ id }) => id)).toEqual(["poster-old"]);
    expect(page.categories).toEqual([WORKBENCH_ALL_CATEGORIES, "海报", "角色"]);
  });

  test("rejects invalid pagination", () => {
    expect(() => paginateGenerationJobs([], { page: 0, pageSize: 20 })).toThrow("page");
    expect(() => paginateGenerationJobs([], { page: 1, pageSize: 101 })).toThrow("pageSize");
  });
});

describe("generation job list query", () => {
  test("sends a normalized category query to the server", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ items: [], page: 1, pageSize: 20, total: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await listGenerationJobs({ category: "  海报  " });
      expect(new URL(requests[0]!, "http://test.invalid").searchParams.get("category")).toBe("海报");
      await listGenerationJobs({ category: WORKBENCH_ALL_CATEGORIES_LABEL });
      expect(new URL(requests[1]!, "http://test.invalid").searchParams.get("category")).toBe(WORKBENCH_ALL_CATEGORIES_LABEL);
      await listGenerationJobs({ category: WORKBENCH_ALL_CATEGORIES });
      expect(new URL(requests[2]!, "http://test.invalid").searchParams.get("category")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves optional category metadata from the server page", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      items: [], page: 1, pageSize: 20, total: 0, categories: ["海报", "角色"],
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      expect((await listGenerationJobs()).categories).toEqual(["海报", "角色"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("generation job HTTP lifecycle", () => {
  test("recovers a running job with its observed version and refreshes after a CAS conflict", async () => {
    const current = { ...job("job-recover-cas", "2026-08-01T00:00:00Z"), status: "running" as const, updatedAt: "2026-08-01T00:00:01Z" };
    const latest = { ...current, status: "succeeded" as const, updatedAt: "2026-08-01T00:00:02Z" };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if ((init?.method ?? "GET") === "POST") return new Response("changed", { status: 409 });
      return responseFor(latest);
    }) as typeof fetch;

    await expect(failGenerationJobIfUnchanged(current, "页面刷新后浏览器任务已中断")).resolves.toEqual(latest);
    expect(requests.map(({ url, init }) => `${init?.method ?? "GET"} ${url}`)).toEqual([
      "POST /api/generation-jobs/job-recover-cas/recover",
      "GET /api/generation-jobs/job-recover-cas",
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      expectedUpdatedAt: current.updatedAt,
      error: "页面刷新后浏览器任务已中断",
    });
  });

  test("creates browser and server generation jobs with bounded request contracts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const image = job("server-image", "2026-08-01T00:00:00Z");
    const video = { ...job("server-video", "2026-08-01T00:00:00Z", "video"), kind: "video" as const };
    const audio = { ...job("server-audio", "2026-08-01T00:00:00Z", "audio"), kind: "audio" as const };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/generation-jobs/image")) return responseFor(image);
      if (String(input).endsWith("/generation-jobs/video")) return responseFor(video);
      if (String(input).endsWith("/generation-jobs/audio")) return responseFor(audio);
      return responseFor({ ...job("browser-job", "2026-08-01T00:00:00Z"), kind: "text" });
    }) as typeof fetch;

    const browser = await createGenerationJob({ ...job("input-job", "2026-08-01T00:00:00Z"), id: undefined });
    const serverImage = await createServerImageGenerationJob({
      id: "server-image", projectId: "board-1", prompt: "draw", providerId: "image-main",
      parameters: { size: "1024x1024", count: 1, category: "poster" },
    });
    const serverVideo = await createServerVideoGenerationJob({
      id: "server-video", projectId: "board-1", prompt: "animate", providerId: "video-main",
      parameters: { ratio: "16:9", resolution: "720p" },
    });
    const serverAudio = await createServerAudioGenerationJob({
      id: "server-audio", projectId: "board-1", prompt: "speak", providerId: "audio-main",
      parameters: { voice: "alloy", format: "mp3" },
    });

    expect(browser.id).toBe("browser-job");
    expect(serverImage.id).toBe("server-image");
    expect(serverVideo.id).toBe("server-video");
    expect(serverAudio.id).toBe("server-audio");
    expect(requests.map(({ url }) => url)).toEqual([
      "/api/generation-jobs",
      "/api/generation-jobs/image",
      "/api/generation-jobs/video",
      "/api/generation-jobs/audio",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ id: "server-image", parameters: { category: "poster" } });
  });

  test("reads, updates, cancels, and deletes one job through the API", async () => {
    const current = job("job-http", "2026-08-01T00:00:00Z");
    const terminal = { ...current, status: "cancelled" as const, error: "cancelled" };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if ((init?.method ?? "GET") === "POST") return responseFor(terminal);
      if ((init?.method ?? "GET") === "PUT") return responseFor({ ...current, prompt: "updated" });
      if (url.endsWith("/job-http")) return responseFor(current);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const updated = await updateGenerationJob("job-http", { prompt: "updated" });
    const cancelled = await cancelServerGenerationJob("job-http");
    await deleteGenerationJob("job-http");

    expect(updated.prompt).toBe("updated");
    expect(cancelled.status).toBe("cancelled");
    expect(requests.map(({ url, init }) => `${init?.method ?? "GET"} ${url}`)).toEqual([
      "GET /api/generation-jobs/job-http",
      "PUT /api/generation-jobs/job-http",
      "POST /api/generation-jobs/job-http/cancel",
      "DELETE /api/generation-jobs/job-http",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ id: "job-http", prompt: "updated" });
  });

  test("rejects malformed server-generation inputs before making a request", async () => {
    const fetchMock = mock(async () => responseFor(job("unexpected", "2026-08-01T00:00:00Z")));
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(createServerImageGenerationJob({
      id: "../bad", projectId: "board-1", prompt: "draw", providerId: "image-main",
      parameters: { size: "1024x1024", count: 1 },
    })).rejects.toThrow("invalid server image generation input");
    await expect(createServerVideoGenerationJob({
      id: "video", projectId: "../bad", prompt: "animate", providerId: "video-main",
      parameters: { ratio: "16:9", resolution: "720p" },
    })).rejects.toThrow("invalid server image generation input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("treats a missing job as undefined and preserves non-404 failures", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("missing")) return new Response("gone", { status: 404 });
      return new Response("upstream unavailable", { status: 503 });
    }) as typeof fetch;

    await expect(getGenerationJob("missing")).resolves.toBeUndefined();
    await expect(getGenerationJob("job-http")).rejects.toMatchObject({ status: 503 });
    await expect(getGenerationJob("../invalid")).rejects.toThrow("invalid generation job id");
  });

  test("deletes unique jobs and projects, returning server counts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ deleted: 3 }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await expect(deleteGenerationJobs(["job-a", "job-a", "../bad", "job-b"])).resolves.toBe(3);
    await expect(deleteGenerationJobsForProject("board-1")).resolves.toBe(3);
    await expect(deleteGenerationJobsForProject("../bad")).rejects.toThrow("invalid project id");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ ids: ["job-a", "job-b"] });
    expect(requests[1]?.url).toBe("/api/generation-jobs/project/board-1");
  });

  test("lists all pages and includes deleted media when collecting storage keys", async () => {
    const first = job("page-one", "2026-08-02T00:00:00Z");
    first.result = { items: [{ storageKey: "image:one", thumbnailStorageKey: "image:one-thumb" }] };
    const second = job("page-two", "2026-08-01T00:00:00Z");
    second.result = { items: [{ storageKey: "media:two" }] };
    const firstPage = [first, ...Array.from({ length: 99 }, (_, index) =>
      job(`page-fill-${index}`, "2026-07-01T00:00:00Z"))];
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      return url.includes("page=1") ? pageFor(firstPage, 1, 101) : pageFor([second], 2, 101);
    }) as typeof fetch;

    await expect(listAllGenerationJobs({ includeDeleted: true })).resolves.toEqual([...firstPage, second]);
    await expect(collectGenerationStorageKeys()).resolves.toEqual(new Set(["image:one", "image:one-thumb", "media:two"]));
    expect(requests.filter((url) => url.includes("includeDeleted=1"))).toHaveLength(4);
  });

  test("collects workflow references and outputs through the same cleanup contract", () => {
    const workflow = validateGenerationJob({
      ...job("workflow-storage", "2026-08-01T00:00:00Z", "workflow"),
      parameters: {
        executor: "browser",
        requestHash: "1234567890abcdef",
        templateId: "storage-template",
        templateRevision: 1,
        templateSnapshot: {
          schemaVersion: 1,
          id: "storage-template",
          revision: 1,
          scope: "personal",
          title: "Storage",
          description: "",
          category: "test",
          variables: [{ id: "reference", kind: "image", label: "Reference", required: false }],
          steps: [{
            id: "poster", title: "Poster", promptTemplate: "poster", providerId: "", parameters: { size: "1024x1024", count: 1 },
            references: [{ source: "variable", variableId: "reference" }],
          }],
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        },
        values: { reference: ["image:input"] },
      },
      result: {
        steps: { poster: { status: "succeeded", childJobId: "child", storageKeys: ["image:output"] } },
        outputStorageKeys: ["image:output"],
      },
    });
    expect(collectGenerationStorageKeysFromJobs([workflow])).toEqual(new Set(["image:input", "image:output"]));
  });

  test("replaces validated history and rejects duplicate ids before network access", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const first = job("replace-one", "2026-08-01T00:00:00Z");
    const second = job("replace-two", "2026-08-02T00:00:00Z");
    await expect(replaceGenerationJobs([first, second])).resolves.toBeUndefined();
    await expect(replaceGenerationJobs([first, first])).rejects.toThrow("duplicate generation job id");
    expect(requests).toEqual(["/api/generation-jobs"]);
  });
});

describe("generation job environment and polling boundaries", () => {
  test("selects browser generation only for the isolated localhost E2E mode", () => {
    const priorFlag = Object.getOwnPropertyDescriptor(globalThis, "__OPENBOARD_E2E_BROWSER_GENERATION__");
    const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    try {
      Object.defineProperty(globalThis, "__OPENBOARD_E2E_BROWSER_GENERATION__", { configurable: true, value: true });
      Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost" } });
      expect(usesBrowserE2EGeneration()).toBe(true);
      expect(usesServerGenerationJobs()).toBe(false);
      Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "canvas.example" } });
      expect(usesBrowserE2EGeneration()).toBe(false);
      expect(usesServerGenerationJobs()).toBe(true);
    } finally {
      if (priorFlag) Object.defineProperty(globalThis, "__OPENBOARD_E2E_BROWSER_GENERATION__", priorFlag);
      else delete (globalThis as { __OPENBOARD_E2E_BROWSER_GENERATION__?: boolean }).__OPENBOARD_E2E_BROWSER_GENERATION__;
      if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation);
      else delete (globalThis as { location?: Location }).location;
    }
  });

  test("fails fast for invalid polling inputs, aborts, and missing jobs", async () => {
    await expect(waitForGenerationJob("../bad")).rejects.toThrow("invalid generation job id");
    await expect(waitForGenerationJob("job", { intervalMs: -1 })).rejects.toThrow("invalid generation polling interval");
    const controller = new AbortController();
    controller.abort("stop");
    await expect(waitForGenerationJob("job", { signal: controller.signal })).rejects.toBe("stop");
    await expect(waitForGenerationJob("job", { getJob: async () => undefined })).rejects.toThrow("not found");
  });

  test("uses the default polling wait for a queued job when the interval is zero", async () => {
    const states: GenerationJob[] = [
      { ...job("default-wait", "2026-08-01T00:00:00Z"), status: "queued" },
      job("default-wait", "2026-08-01T00:00:00Z"),
    ];
    await expect(waitForGenerationJob("default-wait", {
      intervalMs: 0,
      getJob: async () => states.shift(),
    })).resolves.toMatchObject({ status: "succeeded" });
  });
});

describe("generation job media lifecycle", () => {
  test("collects references and results without mutating jobs", () => {
    const input = job("with-media", "2026-07-04T00:00:00Z");
    input.parameters = {
      referenceStorageKeys: ["image:reference", "image:shared"],
    };
    input.result = {
      items: [
        { storageKey: "image:result" },
        { storageKey: "image:shared" },
        { url: "https://example.invalid/result.png" },
      ],
    };
    const snapshot = structuredClone(input);

    expect(collectGenerationStorageKeysFromJobs([input])).toEqual(new Set([
      "image:reference",
      "image:shared",
      "image:result",
    ]));
    expect(input).toEqual(snapshot);
  });

  test("collects stored preview thumbnails from generation results", () => {
    const input = job("with-preview", "2026-07-04T00:00:00Z");
    input.result = {
      items: [
        { storageKey: "image:result", thumbnailStorageKey: "image:result-thumb" },
        { storageKey: "media:video", thumbnailStorageKey: "image:video-poster" },
      ],
    };

    expect(collectGenerationStorageKeysFromJobs([input])).toEqual(new Set([
      "image:result",
      "image:result-thumb",
      "media:video",
      "image:video-poster",
    ]));
  });

  test("only returns deleted-job media that has no remaining owner", () => {
    const removed = job("removed", "2026-07-04T00:00:00Z");
    removed.parameters = { referenceStorageKeys: ["image:orphan-ref", "image:shared"] };
    removed.result = { items: [{ storageKey: "image:orphan-result" }, { storageKey: "image:on-canvas" }] };
    const remaining = job("remaining", "2026-07-05T00:00:00Z");
    remaining.parameters = { referenceStorageKeys: ["image:shared"] };

    expect(findUnreferencedGenerationStorageKeys(
      removed,
      [remaining],
      new Set(["image:on-canvas"]),
    )).toEqual(new Set(["image:orphan-ref", "image:orphan-result"]));
  });
});

describe("generation job recovery", () => {
  test("finds only this tab's persisted running jobs without a live activity", () => {
    const ownedOrphan = { ...job("owned-orphan", "2026-07-05T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-one" } };
    const ownedLive = { ...job("owned-live", "2026-07-05T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-one" } };
    const otherTab = { ...job("other-tab", "2026-07-05T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-two" } };
    const recentOtherTab = { ...job("recent-other-tab", "2026-07-19T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-two" } };
    const recentLegacy = {
      ...job("recent-legacy", "2026-07-19T00:00:00Z"),
      status: "running" as const,
      parameters: {},
    };

    expect(findInterruptedGenerationJobs(
      [ownedOrphan, ownedLive, otherTab, recentOtherTab, {
        ...job("legacy-orphan", "2026-07-05T00:00:00Z"), status: "running", parameters: {},
      }, recentLegacy, job("complete", "2026-07-05T00:00:00Z")],
      "tab-one",
      new Set(["owned-live"]),
      Date.parse("2026-07-19T00:10:00Z"),
    ).map((item) => item.id)).toEqual(["owned-orphan", "other-tab", "legacy-orphan"]);
  });

	test("never classifies server-owned jobs as browser-interrupted", () => {
		const serverJob = {
			...job("server-running", "2026-07-05T00:00:00Z"),
			status: "running" as const,
			parameters: { executor: "server", ownerClientId: "tab-one" },
		};
		expect(findInterruptedGenerationJobs(
			[serverJob],
			"tab-one",
			new Set(),
			Date.parse("2026-07-19T00:10:00Z"),
		)).toEqual([]);
	});

	test("recognizes Film stage and export workers as server-owned", () => {
		expect(isServerOwnedGenerationJob({
			...job("film-stage", "2026-07-05T00:00:00Z", "film-stage"),
			parameters: { executor: "film-stage" },
		})).toBe(true);
		expect(isServerOwnedGenerationJob({
			...job("film-export", "2026-07-05T00:00:00Z", "export"),
			parameters: { executor: "film-export" },
		})).toBe(true);
	});


	test("stops polling when a job is soft-deleted", async () => {
		const states: GenerationJob[] = [
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "running", parameters: { executor: "server" } },
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "deleted", parameters: { executor: "server" } },
		];
		const completed = await waitForGenerationJob("server-job", {
			getJob: async () => states.shift(),
			wait: async () => undefined,
		});
		expect(completed.status).toBe("deleted");
	});

	test("polls one persisted server job until it reaches a terminal state", async () => {
		const states: GenerationJob[] = [
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "queued", parameters: { executor: "server" } },
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "running", parameters: { executor: "server" } },
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "succeeded", parameters: { executor: "server" } },
		];
		const requested: string[] = [];
		const observed: string[] = [];
		const completed = await waitForGenerationJob("server-job", {
			getJob: async (id) => {
				requested.push(id);
				return states.shift();
			},
			wait: async () => undefined,
			onUpdate: (value) => observed.push(value.status),
		});
		expect(completed.status).toBe("succeeded");
		expect(requested).toEqual(["server-job", "server-job", "server-job"]);
		expect(observed).toEqual(["queued", "running", "succeeded"]);
	});
});

describe("generation job cascade cleanup", () => {
  test("selects only the requested project history", () => {
    const jobs = [
      { ...job("job-a", "2026-07-01T00:00:00.000Z"), projectId: "board-a" },
      { ...job("job-b", "2026-07-01T00:00:00.000Z", "video"), projectId: "board-b" },
    ];
    expect(selectGenerationJobsForProject(jobs, "board-a").map((item) => item.id)).toEqual(["job-a"]);
  });

  test("selects node-linked jobs by nodeId or generationJobId", () => {
    const jobs = [
      {
        ...job("job-node", "2026-07-01T00:00:00.000Z"),
        projectId: "board-a",
        parameters: { nodeId: "node-1" },
      },
      {
        ...job("job-linked", "2026-07-01T00:00:00.000Z"),
        projectId: "board-a",
      },
      {
        ...job("job-other", "2026-07-01T00:00:00.000Z"),
        projectId: "board-a",
        parameters: { nodeId: "node-2" },
      },
      {
        ...job("job-foreign", "2026-07-01T00:00:00.000Z"),
        projectId: "board-b",
        parameters: { nodeId: "node-1" },
      },
    ];
    expect(selectGenerationJobsForNodeCleanup(
      jobs,
      "board-a",
      new Set(["node-1"]),
      new Set(["job-linked"]),
    ).map((item) => item.id).sort()).toEqual(["job-linked", "job-node"]);
  });
});

describe("generation job bulk delete helpers", () => {
  test("deduplicates and validates job ids", () => {
    expect(uniqueGenerationJobIds(["job-a", "job-a", "../bad", "job-b", ""])).toEqual(["job-a", "job-b"]);
  });
});

describe("generation job soft delete status", () => {
  test("accepts soft-deleted generation status", () => {
    const deleted = validateGenerationJob({
      ...job("job-soft", "2026-07-01T00:00:00.000Z"),
      status: "deleted",
      error: "已删除",
      result: { items: [{ storageKey: "image:soft" }] },
    });
    expect(deleted.status).toBe("deleted");
  });
});
