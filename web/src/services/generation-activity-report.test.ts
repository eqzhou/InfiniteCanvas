import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearSessionToken, setSessionToken } from "./auth-session";
import {
  clearGenerationActivities,
  completeGenerationActivity,
  invalidateAICallLogClientReportCache,
  runTrackedGeneration,
} from "./generation-activity";

const reported: { kind: string; status: string }[] = [];
const originalFetch = globalThis.fetch;

/** Let the fire-and-forget report task settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("client AI call audit reporting", () => {
  // Stub fetch and a throwaway session store instead of replacing
  // `ai-call-logs` for the whole test process.
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  beforeEach(() => {
    reported.length = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/ai-call-logs/client-report") && method === "GET") {
        return new Response(JSON.stringify({ enabled: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/ai-call-logs/report") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { kind: string; status: string };
        reported.push({ kind: body.kind, status: body.status });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as typeof fetch;
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/workbench/image" } },
    });
    setSessionToken("session-token");
    clearGenerationActivities();
    invalidateAICallLogClientReportCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
    clearSessionToken();
    invalidateAICallLogClientReportCache();
    if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else delete (globalThis as { window?: Window & typeof globalThis }).window;
  });

  test("reports the non-deferred success path", async () => {
    await runTrackedGeneration({ kind: "image", prompt: "canvas run" }, async () => "ok");
    await flush();
    expect(reported).toEqual([{ kind: "image", status: "succeeded" }]);
  });

  test("reports a deferred run that later succeeds", async () => {
    await runTrackedGeneration({
      id: "job-deferred",
      kind: "image",
      prompt: "workbench run",
      surface: "image-workbench",
      deferSuccess: true,
    }, async () => "provider-result");
    await flush();
    // The provider call already happened and was billed; the deferral only
    // postpones the *activity* completion until media upload finishes.
    expect(reported).toEqual([]);

    completeGenerationActivity("job-deferred", "succeeded");
    await flush();
    expect(reported).toEqual([{ kind: "image", status: "succeeded" }]);
  });

  test("reports a deferred run that fails after the provider succeeds", async () => {
    await runTrackedGeneration({
      id: "job-media-failed",
      kind: "image",
      prompt: "workbench run",
      surface: "image-workbench",
      deferSuccess: true,
    }, async () => "provider-result");
    await flush();
    expect(reported).toEqual([]);

    completeGenerationActivity("job-media-failed", "failed", "media upload failed");
    await flush();
    expect(reported).toEqual([{ kind: "image", status: "failed" }]);
  });

  test("does not double-report a deferred run that already reported a failure", async () => {
    await expect(runTrackedGeneration({
      id: "job-failed",
      kind: "video",
      prompt: "workbench run",
      surface: "video-workbench",
      deferSuccess: true,
    }, async () => {
      throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    await flush();
    expect(reported).toEqual([{ kind: "video", status: "failed" }]);

    // The workbench catch block also calls completeGenerationActivity.
    completeGenerationActivity("job-failed", "failed", "provider failed");
    await flush();
    expect(reported).toEqual([{ kind: "video", status: "failed" }]);
  });
});
