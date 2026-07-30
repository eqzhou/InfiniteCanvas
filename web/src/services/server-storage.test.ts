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
  const projectWithTransientImage = (): BoardProject => ({
    ...project("canvas"),
    nodes: [{
      id: "node-large",
      type: "image",
      title: "large",
      position: { x: 0, y: 0 },
      width: 320,
      height: 240,
      metadata: {
        storageKey: "image:large",
        content: `/api/media/references/${"a".repeat(64)}`,
      },
    }],
  });

  test("repairs an accidentally persisted display URL before project validation", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("/api/projects")
        ? Response.json([{ id: "canvas" }])
        : Response.json(projectWithTransientImage());
    }) as typeof fetch;

    const { loadServerProjects } = await import("./server-storage");
    const [loaded] = await loadServerProjects();

    expect(loaded?.nodes[0]?.metadata.storageKey).toBe("image:large");
    expect(loaded?.nodes[0]?.metadata.content).toBeUndefined();
  });

  test("never persists a temporary display URL with the project document", async () => {
    let saved: BoardProject | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      saved = JSON.parse(String(init?.body)) as BoardProject;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const { saveServerProjects } = await import("./server-storage");
    await saveServerProjects([projectWithTransientImage()]);

    expect(saved?.nodes[0]?.metadata.storageKey).toBe("image:large");
    expect(saved?.nodes[0]?.metadata.content).toBeUndefined();
  });

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

  // A tab that still holds a project the user deleted elsewhere gets 410 from
  // the server. That tombstone is authoritative, so autosave must drop the dead
  // project instead of failing the whole batch and retrying forever.
  test("saveServerProjects treats a 410 tombstone as settled, not as a failure", async () => {
    const attempted: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        attempted.push(url);
        if (url.includes("/api/projects/deleted-elsewhere")) {
          return new Response("project was deleted", { status: 410 });
        }
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { saveServerProjects } = await import("./server-storage");
    const gone = await saveServerProjects([project("still-alive"), project("deleted-elsewhere")]);

    expect(attempted.some((url) => url.includes("/api/projects/still-alive"))).toBe(true);
    expect(gone).toEqual(["deleted-elsewhere"]);
  });

  test("saveServerProjects still surfaces genuine server failures", async () => {
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        return new Response("boom", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { saveServerProjects } = await import("./server-storage");
    await expect(saveServerProjects([project("still-alive")])).rejects.toThrow();
  });
});

describe("server blob display URLs", () => {
  test("mints authenticated short-lived URLs so large images can stream without a JS Blob copy", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({
        items: [
          { token: ["display", "reference"].join("-"), storageKey: "image:large", expiresAt: "2026-07-30T02:00:00Z" },
        ],
        expiresAt: "2026-07-30T02:00:00Z",
      }, { status: 201 });
    }) as typeof fetch;

    const { createServerBlobDisplayUrls } = await import("./server-storage");
    const urls = await createServerBlobDisplayUrls(["image:large", "image:large"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith("/api/media/references")).toBe(true);
    expect(calls[0]?.body).toEqual({ storageKeys: ["image:large"], ttlSeconds: 3600 });
    expect(urls.get("image:large")).toBe("/api/media/references/display-reference");
  });
});

describe("config compare-and-swap transport", () => {
  const version = `"m1-${"b".repeat(64)}"`;

  test("loads config and credentials atomically from one response", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        config: { channels: [{ id: "personal" }] },
        secrets: { apiKeys: { personal: { image: "sk-private" } } },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: version },
      });
    }) as typeof fetch;

    const { loadServerConfigBundle } = await import("./server-storage");
    const bundle = await loadServerConfigBundle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.endsWith("/api/config")).toBe(true);
    expect(bundle).toEqual({
      config: { channels: [{ id: "personal" }] },
      secrets: { apiKeys: { personal: { image: "sk-private" } } },
    });
  });

  test("uses the version loaded with config for the next save", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(init ?? {});
      if (method === "GET") {
        return new Response(JSON.stringify({ channels: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: version },
        });
      }
      return new Response(null, { status: 204, headers: { ETag: `"m1-${"c".repeat(64)}"` } });
    }) as typeof fetch;

    const { loadServerState, saveServerState } = await import("./server-storage");
    await loadServerState("config");
    await saveServerState("config", { channels: [] } as never);

    expect(new Headers(calls[1]?.headers).get("If-Match")).toBe(version);
    expect(new Headers(calls[1]?.headers).has("If-None-Match")).toBe(false);
  });

  test("uses create-only semantics when config did not exist", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      if ((init?.method ?? "GET").toUpperCase() === "GET") return new Response(null, { status: 404 });
      return new Response(null, { status: 204, headers: { ETag: version } });
    }) as typeof fetch;

    const { loadServerState, saveServerState } = await import("./server-storage");
    await loadServerState("config");
    await saveServerState("config", { channels: [] } as never);

    expect(new Headers(calls[1]?.headers).get("If-None-Match")).toBe("*");
  });

  test("surfaces a stale config save instead of overwriting another tab", async () => {
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        return new Response(JSON.stringify({ channels: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: version },
        });
      }
      return new Response(null, { status: 412 });
    }) as typeof fetch;

    const { ConfigPreconditionError, loadServerState, saveServerState } = await import("./server-storage");
    await loadServerState("config");
    await expect(saveServerState("config", { channels: [] } as never))
      .rejects.toBeInstanceOf(ConfigPreconditionError);
  });

  test("saves config and credentials in one conditional request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        return new Response(JSON.stringify({ channels: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: version },
        });
      }
      return new Response(null, { status: 204, headers: { ETag: `"m1-${"d".repeat(64)}"` } });
    }) as typeof fetch;

    const { loadServerState, saveServerConfigBundle } = await import("./server-storage");
    await loadServerState("config");
    await saveServerConfigBundle({ channels: [] } as never, {
      apiKeys: { personal: { image: "sk-private" } },
    });

    expect(calls[1]?.url.endsWith("/api/config")).toBe(true);
    expect(new Headers(calls[1]?.init.headers).get("If-Match")).toBe(version);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      config: { channels: [] },
      secrets: { apiKeys: { personal: { image: "sk-private" } } },
    });
  });
});

describe("secret bag auth boundaries", () => {
  test("treats 401 as login required rather than a generic secret failure", async () => {
    globalThis.fetch = mock(async () => new Response("login required", { status: 401 })) as typeof fetch;
    const { SecretAuthRequiredError, saveServerSecrets } = await import("./server-storage");
    await expect(saveServerSecrets({ apiKeys: {}, webdavPass: "" })).rejects.toBeInstanceOf(SecretAuthRequiredError);
  });

  test("loadServerSecrets returns null for guests instead of throwing", async () => {
    for (const status of [401, 403, 404]) {
      globalThis.fetch = mock(async () => new Response(null, { status })) as typeof fetch;
      const { loadServerSecrets } = await import("./server-storage");
      expect(await loadServerSecrets()).toBeNull();
    }
  });

  test("authorized secret-only updates use and advance the composite version", async () => {
    const firstVersion = `"m1-${"e".repeat(64)}"`;
    const nextVersion = `"m1-${"f".repeat(64)}"`;
    const calls: RequestInit[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        return new Response(JSON.stringify({ channels: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: firstVersion },
        });
      }
      return new Response(null, { status: 204, headers: { ETag: nextVersion } });
    }) as typeof fetch;

    const { loadServerState, saveServerSecrets, saveServerConfigBundle } = await import("./server-storage");
    await loadServerState("config");
    await saveServerSecrets({ apiKeys: {}, webdavPass: "" });
    await saveServerConfigBundle({ channels: [] } as never, { apiKeys: {}, webdavPass: "" });

    expect(new Headers(calls[1]?.headers).get("If-Match")).toBe(firstVersion);
    expect(new Headers(calls[2]?.headers).get("If-Match")).toBe(nextVersion);
  });
});
