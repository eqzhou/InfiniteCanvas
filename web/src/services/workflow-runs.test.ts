import { afterEach, describe, expect, mock, test } from "bun:test";

import { buildWorkflowGenerationJob } from "@/lib/workflow-job";
import { PUBLIC_WORKFLOW_TEMPLATES } from "@/services/workflow-templates";
import type { GenerationJob } from "@/types/board";
import type { AppConfig } from "@/types/board";
import {
  cancelWorkflowRun,
  createWorkflowRun,
  executeBrowserWorkflowRun,
  listWorkflowRuns,
  resumeWorkflowRun,
  retryWorkflowRun,
} from "./workflow-runs";

const originalFetch = globalThis.fetch;
const originalFlag = Object.getOwnPropertyDescriptor(globalThis, "__OPENBOARD_E2E_BROWSER_GENERATION__");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const template = PUBLIC_WORKFLOW_TEMPLATES[0]!;
const values = { subject: "a lighthouse", style: "电影感", reference: [] };

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  if (originalFlag) Object.defineProperty(globalThis, "__OPENBOARD_E2E_BROWSER_GENERATION__", originalFlag);
  else delete (globalThis as { __OPENBOARD_E2E_BROWSER_GENERATION__?: boolean }).__OPENBOARD_E2E_BROWSER_GENERATION__;
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else delete (globalThis as { location?: Location }).location;
});

function setBrowserMode(browser: boolean): void {
  Object.defineProperty(globalThis, "__OPENBOARD_E2E_BROWSER_GENERATION__", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { hostname: browser ? "localhost" : "canvas.example" },
  });
}

function buildRun(id: string, executor: "browser" | "workflow" = "workflow", status: GenerationJob["status"] = "queued"): GenerationJob {
  return {
    ...buildWorkflowGenerationJob({
      id,
      projectId: "board-1",
      template,
      values,
      executor,
      timestamp: "2026-08-01T00:00:00.000Z",
    }),
    status,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("workflow run HTTP ownership", () => {
  test("creates a server-owned workflow with a frozen template snapshot", async () => {
    setBrowserMode(false);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const body = JSON.parse(String(init?.body));
      return jsonResponse(buildRun(body.id, "workflow"));
    }) as typeof fetch;

    const created = await createWorkflowRun({ projectId: "board-1", template, values });

    expect(created.parameters.executor).toBe("workflow");
    expect(requests[0]?.url).toBe("/api/generation-jobs/workflow");
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      id: created.id,
      projectId: "board-1",
      templateSnapshot: template,
      values,
    });
  });

  test("creates a browser-owned workflow through the generic history endpoint in isolated E2E mode", async () => {
    setBrowserMode(true);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const body = JSON.parse(String(init?.body));
      return jsonResponse(buildRun(body.id, "browser"));
    }) as typeof fetch;

    const created = await createWorkflowRun({ template, values });

    expect(created.parameters.executor).toBe("browser");
    expect(requests[0]?.url).toBe("/api/generation-jobs");
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      id: created.id,
      kind: "workflow",
      parameters: { executor: "browser" },
    });
  });

  test("lists only workflow jobs in the requested project scope", async () => {
    setBrowserMode(false);
    const run = buildRun("listed-run");
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return jsonResponse({ items: [run], page: 1, pageSize: 100, total: 1 });
    }) as typeof fetch;

    await expect(listWorkflowRuns("board-1")).resolves.toEqual([run]);
    expect(requests[0]).toBe("/api/generation-jobs?page=1&pageSize=100&projectId=board-1&kind=workflow");
  });
});

describe("workflow run lifecycle", () => {
  test("cancels a server run through its dedicated endpoint", async () => {
    setBrowserMode(false);
    const run = buildRun("server-cancel");
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse({ ...run, status: "cancelled", error: "已取消" });
    }) as typeof fetch;

    const cancelled = await cancelWorkflowRun(run);

    expect(cancelled.status).toBe("cancelled");
    expect(requests).toEqual(["POST /api/generation-jobs/server-cancel/cancel"]);
  });

  test("cancels a browser run and marks pending steps without touching unrelated history", async () => {
    setBrowserMode(true);
    const run = buildRun("browser-cancel", "browser");
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
      return jsonResponse(run);
    }) as typeof fetch;

    const cancelled = await cancelWorkflowRun(run);

    expect(cancelled.status).toBe("cancelled");
    expect((cancelled.result as { steps: Record<string, { status: string }> }).steps.poster?.status).toBe("cancelled");
    expect(requests).toEqual([
      "GET /api/generation-jobs/browser-cancel",
      "PUT /api/generation-jobs/browser-cancel",
    ]);
  });

  test("retries a run from its immutable template snapshot and values", async () => {
    setBrowserMode(false);
    const run = buildRun("retry-source", "workflow", "failed");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      return jsonResponse(buildRun(String(body.id), "workflow"));
    }) as typeof fetch;

    const retried = await retryWorkflowRun(run);

    expect(retried.parameters.executor).toBe("workflow");
    expect(requests[0]?.url).toBe("/api/generation-jobs/workflow");
    expect(requests[0]?.body).toMatchObject({ projectId: "board-1", templateSnapshot: template, values });
  });

  test("resumes a server run by polling its terminal state and forwarding updates", async () => {
    setBrowserMode(false);
    const run = buildRun("resume-server", "workflow", "running");
    const updates: string[] = [];
    globalThis.fetch = mock(async () => jsonResponse({ ...run, status: "succeeded" })) as typeof fetch;

    const resumed = await resumeWorkflowRun(run, {} as AppConfig, { onUpdate: (job) => updates.push(job.status) });

    expect(resumed.status).toBe("succeeded");
    expect(updates).toEqual(["succeeded"]);
  });
});

describe("browser workflow checkpoint failures", () => {
  test("recovers completed child media after refresh without writing undefined JSON fields", async () => {
    setBrowserMode(true);
    const run = buildRun("browser-recover-success", "browser", "running");
    run.result = {
      steps: { poster: { status: "running", childJobId: "child-succeeded" } },
      outputStorageKeys: [],
    };
    const child: GenerationJob = {
      id: "child-succeeded",
      projectId: "board-1",
      kind: "image",
      status: "succeeded",
      prompt: "child",
      parameters: { count: 1 },
      result: { items: [{ storageKey: "image:child-output" }] },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/child-succeeded")) return jsonResponse(child);
      if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
      return jsonResponse(run);
    }) as typeof fetch;

    const recovered = await executeBrowserWorkflowRun(run, {} as AppConfig);

    expect(recovered.status).toBe("succeeded");
    expect(recovered.result.steps.poster).toMatchObject({
      status: "succeeded",
      storageKeys: ["image:child-output"],
    });
    expect(recovered.result.steps.poster).not.toHaveProperty("error");
  });

  test("does not overwrite a child that completed during interrupted recovery", async () => {
    setBrowserMode(true);
    const run = buildRun("browser-recover-race", "browser", "running");
    run.result = {
      steps: { poster: { status: "running", childJobId: "child-race" } },
      outputStorageKeys: [],
    };
    const childRunning: GenerationJob = {
      id: "child-race",
      projectId: "board-1",
      kind: "image",
      status: "running",
      prompt: "child",
      parameters: { count: 1 },
      result: {},
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:01.000Z",
    };
    const childSucceeded: GenerationJob = {
      ...childRunning,
      status: "succeeded",
      result: { items: [{ storageKey: "image:race-output" }] },
      updatedAt: "2026-08-01T00:00:02.000Z",
    };
    let childReads = 0;
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/child-race/recover")) return new Response("changed", { status: 409 });
      if (url.endsWith("/child-race")) {
        childReads += 1;
        return jsonResponse(childReads === 1 ? childRunning : childSucceeded);
      }
      if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
      return jsonResponse(run);
    }) as typeof fetch;

    const recovered = await executeBrowserWorkflowRun(run, {} as AppConfig);

    expect(recovered.status).toBe("succeeded");
    expect(recovered.result.steps.poster).toMatchObject({
      status: "succeeded",
      storageKeys: ["image:race-output"],
    });
    expect(requests).toContain("POST /api/generation-jobs/child-race/recover");
    expect(requests).not.toContain("PUT /api/generation-jobs/child-race");
  });

  test("marks a running child failed when refresh finds no completed child media", async () => {
    setBrowserMode(true);
    const run = buildRun("browser-recover-failed", "browser", "running");
    run.result = {
      steps: { poster: { status: "running", childJobId: "child-running" } },
      outputStorageKeys: [],
    };
    const child: GenerationJob = {
      id: "child-running",
      projectId: "board-1",
      kind: "image",
      status: "running",
      prompt: "child",
      parameters: { count: 1 },
      result: {},
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/child-running/recover")) {
        return jsonResponse({ ...child, status: "failed", error: "页面刷新后浏览器任务已中断，请按快照重试" });
      }
      if (url.endsWith("/child-running")) {
        if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
        return jsonResponse(child);
      }
      if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
      return jsonResponse(run);
    }) as typeof fetch;

    const failed = await executeBrowserWorkflowRun(run, {} as AppConfig);

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("页面刷新后浏览器任务已中断");
  });

  test("fails and checkpoints a browser run when no image channel is configured", async () => {
    setBrowserMode(true);
    const run = buildRun("browser-no-channel", "browser");
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
      return jsonResponse(run);
    }) as typeof fetch;

    const result = await executeBrowserWorkflowRun(run, { channels: [] } as AppConfig);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("图片生成失败");
    expect(requests.filter((entry) => entry.startsWith("PUT ")).length).toBeGreaterThanOrEqual(2);
  });

  test("rejects a server-owned job passed to the browser executor", async () => {
    setBrowserMode(true);
    await expect(executeBrowserWorkflowRun(buildRun("server-owned", "workflow"), {} as AppConfig))
      .rejects.toThrow("workflow is not browser-owned");
  });
});

describe("browser workflow execution and recovery boundaries", () => {
  test("marks a recovery with no child records as interrupted", async () => {
    setBrowserMode(true);
    const run = buildRun("browser-recover-empty", "browser", "running");
    run.result = {
      steps: { poster: { status: "queued", childJobIds: ["missing-child"] } },
      outputStorageKeys: [],
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/missing-child")) return new Response("gone", { status: 404 });
      if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
      return jsonResponse(run);
    }) as typeof fetch;

    const result = await executeBrowserWorkflowRun(run, {} as AppConfig);
    expect(result.status).toBe("failed");
    expect(result.result.steps.poster?.status).toBe("failed");
    expect(result.result.steps.poster?.error).toContain("页面刷新后浏览器任务已中断");
  });

  test("cancels an already-aborted browser run through child history cleanup", async () => {
    setBrowserMode(true);
    const run = buildRun("browser-aborted", "browser");
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if ((init?.method ?? "GET") === "PUT") return jsonResponse(JSON.parse(String(init?.body)));
      return jsonResponse(run);
    }) as typeof fetch;
    const controller = new AbortController();
    controller.abort("user cancelled");

    const result = await executeBrowserWorkflowRun(run, {} as AppConfig, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("已取消");
    expect(requests).toContain("GET /api/generation-jobs/browser-aborted");
    expect(requests).toContain("PUT /api/generation-jobs/browser-aborted");
  });

});
