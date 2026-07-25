import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BoardProject } from "@/types/board";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function project(id: string): BoardProject {
  return {
    id,
    title: id,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nodes: [],
    edges: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    viewport: { x: 0, y: 0, k: 1 },
  };
}

describe("server project persistence isolation", () => {
  test("saveServerProjects only upserts and never deletes remote projects", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), url });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { saveServerProjects } = await import("./server-storage");
    await saveServerProjects([project("shared"), project("local-only")]);

    const methods = calls.map((call) => call.method);
    expect(methods.every((method) => method === "PUT")).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/projects/shared"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/api/projects/local-only"))).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("replaceServerProjects deletes remote projects outside the replacement set", async () => {
    const deleted: string[] = [];
    const put: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/api/projects") && !url.includes("/api/projects/")) {
        return new Response(JSON.stringify([{ id: "remote-only" }, { id: "shared" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PUT") {
        put.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { replaceServerProjects } = await import("./server-storage");
    await replaceServerProjects([project("shared"), project("imported")]);

    expect(put.some((url) => url.includes("/api/projects/shared"))).toBe(true);
    expect(put.some((url) => url.includes("/api/projects/imported"))).toBe(true);
    expect(deleted.some((url) => url.includes("/api/projects/remote-only"))).toBe(true);
    expect(deleted.some((url) => url.includes("/api/projects/shared"))).toBe(false);
  });
});
