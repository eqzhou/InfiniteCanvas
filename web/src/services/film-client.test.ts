import { afterEach, describe, expect, mock, test } from "bun:test";

import { loadFilmCapabilities, loadFilmStatus, restoreFilmProduction } from "./film-client";
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

    expect(capability).toEqual({
      available: true, reason: "", mp4Export: false, mp4Diagnostic: "MP4 export is disabled",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/film/capabilities");
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
});
