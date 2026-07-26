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

describe("migration compare-and-swap transport", () => {
  const version = `m1-${"a".repeat(64)}`;

  test("loads resource versions in bounded batches and preserves request ordering", async () => {
    const batchSizes: number[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { resources: Array<{ kind: string; id: string }> };
      batchSizes.push(body.resources.length);
      return Response.json({
        resources: body.resources.map((resource, index) => ({
          ...resource,
          exists: index % 2 === 0,
          ...(index % 2 === 0 ? { version } : {}),
        })),
      });
    }) as typeof fetch;

    const { loadMigrationResourceVersions } = await import("./server-storage");
    const resources = Array.from({ length: 101 }, (_, index) => ({
      kind: "blob" as const,
      id: `asset-${index}`,
    }));
    const result = await loadMigrationResourceVersions(resources);

    expect(batchSizes).toEqual([100, 1]);
    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({ ...resources[0], exists: true, version });
    expect(result[100]).toEqual({ ...resources[100], exists: true, version });
  });

  test("rejects malformed or reordered version responses", async () => {
    globalThis.fetch = mock(async () => Response.json({
      resources: [{ kind: "state", id: "prompts", exists: false }],
    })) as typeof fetch;

    const { loadMigrationResourceVersions } = await import("./server-storage");
    await expect(loadMigrationResourceVersions([{ kind: "state", id: "assets" }]))
      .rejects.toThrow("Migration version response is invalid");
  });

  test("sends create-only and exact-version preconditions", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const { saveMigrationState } = await import("./server-storage");
    await saveMigrationState("assets", [], null);
    await saveMigrationState("prompts", [], version);

    expect(new Headers(calls[0]?.headers).get("If-None-Match")).toBe("*");
    expect(new Headers(calls[0]?.headers).has("If-Match")).toBe(false);
    expect(new Headers(calls[1]?.headers).get("If-Match")).toBe(`"${version}"`);
    expect(new Headers(calls[1]?.headers).has("If-None-Match")).toBe(false);
  });

  test("surfaces a stale write as a resumable migration precondition error", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 412 })) as typeof fetch;

    const { MigrationPreconditionError, saveMigrationProject } = await import("./server-storage");
    await expect(saveMigrationProject(project("raced"), null))
      .rejects.toBeInstanceOf(MigrationPreconditionError);
  });
});

describe("migration capability declaration", () => {
  test("uses the server answer when the server actually answers", async () => {
    for (const allowSecrets of [true, false]) {
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ allowSecrets }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
      const { loadMigrationCapabilities } = await import("./server-storage");
      expect(await loadMigrationCapabilities()).toEqual({ allowSecrets });
    }
  });

  test("treats an explicit rejection as a denial", async () => {
    for (const status of [401, 403]) {
      globalThis.fetch = mock(async () => new Response(null, { status })) as typeof fetch;
      const { loadMigrationCapabilities } = await import("./server-storage");
      expect(await loadMigrationCapabilities()).toEqual({ allowSecrets: false });
    }
  });

  test("never downgrades an unreachable server to a silent denial", async () => {
    // A denial migrates without secrets and then clears the local stores that
    // hold them. Treating a transient failure as a denial would destroy the
    // only copy, so these cases must abort the migration instead.
    const { MigrationCapabilitiesUnavailableError, loadMigrationCapabilities } = await import("./server-storage");

    globalThis.fetch = mock(async () => { throw new TypeError("network down"); }) as typeof fetch;
    await expect(loadMigrationCapabilities()).rejects.toBeInstanceOf(MigrationCapabilitiesUnavailableError);

    globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(loadMigrationCapabilities()).rejects.toBeInstanceOf(MigrationCapabilitiesUnavailableError);

    globalThis.fetch = mock(async () => new Response("not json", { status: 200 })) as typeof fetch;
    await expect(loadMigrationCapabilities()).rejects.toBeInstanceOf(MigrationCapabilitiesUnavailableError);
  });
});
