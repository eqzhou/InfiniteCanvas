import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  deleteAICallLogs,
  getAICallLog,
  getAICallLogClientReport,
  getAICallLogRetention,
  listAICallLogs,
  putAICallLogClientReport,
  putAICallLogRetention,
  reportAICallLog,
} from "./ai-call-logs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AI call log HTTP helpers", () => {
  test("lists logs with trimmed filters and omits empty/default values", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ items: [], page: 2, pageSize: 25, total: 0 });
    }) as typeof fetch;

    await expect(listAICallLogs({
      q: "  lighthouse  ",
      kind: " image ",
      status: " failed ",
      channel: "  primary ",
      page: 2,
      pageSize: 25,
    })).resolves.toMatchObject({ page: 2, pageSize: 25 });
    expect(requests[0]?.url).toBe(
      "/api/ai-call-logs?q=lighthouse&kind=image&status=failed&channel=primary&page=2&pageSize=25",
    );

    await listAICallLogs({ q: "  ", kind: "", status: "\t", channel: "  ", page: 0, pageSize: 0 });
    expect(requests[1]?.url).toBe("/api/ai-call-logs");
  });

  test("gets a log using an encoded identifier and handles a no-content response", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(getAICallLog("job/with spaces")).resolves.toBeUndefined();
    expect(requests).toEqual(["/api/ai-call-logs/job%2Fwith%20spaces"]);
  });

  test("sends delete and retention requests with JSON bodies", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/retention")) {
        return jsonResponse({ enabled: true, retentionDays: 30 });
      }
      return jsonResponse({ deleted: 4 });
    }) as typeof fetch;

    await expect(deleteAICallLogs({ ids: ["a", "b"], olderThanDays: 7 })).resolves.toEqual({ deleted: 4 });
    await expect(getAICallLogRetention()).resolves.toEqual({ enabled: true, retentionDays: 30 });
    await expect(putAICallLogRetention({ enabled: false, retentionDays: 0 })).resolves.toEqual({
      enabled: true,
      retentionDays: 30,
    });

    expect(requests.map(({ url, init }) => `${init?.method ?? "GET"} ${url}`)).toEqual([
      "POST /api/ai-call-logs/delete",
      "GET /api/ai-call-logs/retention",
      "PUT /api/ai-call-logs/retention",
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ ids: ["a", "b"], olderThanDays: 7 });
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ enabled: false, retentionDays: 0 });
  });

  test("normalizes the client-report switch and falls closed on read failures", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let failRead = true;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (failRead) return new Response("unavailable", { status: 503 });
      return jsonResponse({ enabled: true });
    }) as typeof fetch;

    await expect(getAICallLogClientReport()).resolves.toEqual({ enabled: false });
    failRead = false;
    await expect(getAICallLogClientReport()).resolves.toEqual({ enabled: true });
    await expect(putAICallLogClientReport({ enabled: 1 as unknown as boolean })).resolves.toEqual({ enabled: true });
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ enabled: true });
  });

  test("reports bounded duration and default request/response payloads", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(reportAICallLog({
      kind: "image",
      status: "succeeded",
      durationMs: -2.9,
      request: null,
      response: undefined,
    })).resolves.toBeUndefined();
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      kind: "image",
      status: "succeeded",
      channelId: undefined,
      channelName: undefined,
      model: undefined,
      protocol: undefined,
      durationMs: 0,
      error: undefined,
      request: {},
      response: {},
    });
  });

  test("silently ignores report HTTP failures and network failures", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) return new Response("forbidden", { status: 403 });
      throw new Error("offline");
    }) as typeof fetch;

    await expect(reportAICallLog({ kind: "text", status: "failed", durationMs: Number.NaN })).resolves.toBeUndefined();
    await expect(reportAICallLog({ kind: "text", status: "cancelled", durationMs: Number.POSITIVE_INFINITY })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  test("preserves useful HTTP errors and falls back to the status when the body is empty", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/retention")) return new Response("bad policy", { status: 400 });
      return new Response(null, { status: 502 });
    }) as typeof fetch;

    await expect(getAICallLogRetention()).rejects.toThrow("bad policy");
    await expect(getAICallLog("missing")).rejects.toThrow("HTTP 502");
  });
});
