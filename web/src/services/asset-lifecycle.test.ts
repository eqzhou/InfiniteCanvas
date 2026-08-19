import { afterEach, describe, expect, mock, test } from "bun:test";

import { createNode, createProject } from "@/lib/defaults";
import { useBoardStore } from "@/stores/use-board-store";
import { deleteAssetBlobIfUnreferenced } from "./asset-lifecycle";

const originalFetch = globalThis.fetch;
const originalStore = useBoardStore.getState();

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  useBoardStore.setState({
    projectsState: originalStore.projectsState,
    projects: originalStore.projects,
    loadProjectsOnDemand: originalStore.loadProjectsOnDemand,
  });
});

function generationPage(items: unknown[] = []): Response {
  return new Response(JSON.stringify({ items, page: 1, pageSize: 100, total: items.length, categories: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function projectWithStorage(storageKey?: string) {
  const project = createProject("Lifecycle");
  project.nodes = [createNode("image", { x: 0, y: 0 }, {
    id: "image-node",
    metadata: { storageKey, thumbnailStorageKey: storageKey ? "image:thumb" : undefined },
  })];
  return project;
}

describe("asset blob lifecycle", () => {
  test("does nothing for an empty storage key", async () => {
    const fetchMock = mock(async () => generationPage());
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(deleteAssetBlobIfUnreferenced(undefined, [], [])).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps blobs referenced by the latest loaded project or remaining asset", async () => {
    const project = projectWithStorage("image:keep");
    useBoardStore.setState({ projectsState: "loaded", projects: [project] });
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return generationPage();
    }) as typeof fetch;

    await expect(deleteAssetBlobIfUnreferenced("image:keep", [], [])).resolves.toBeUndefined();
    await expect(deleteAssetBlobIfUnreferenced("image:asset", [], [{
      id: "asset-1",
      kind: "image",
      title: "Asset",
      tags: [],
      storageKey: "image:asset",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    }])).resolves.toBeUndefined();
    expect(requests.filter((url) => url.includes("/api/blobs/")).length).toBe(0);
  });

  test("keeps blobs referenced by a generation-history result", async () => {
    useBoardStore.setState({ projectsState: "loaded", projects: [projectWithStorage()] });
    const historyJob = {
      id: "history-job",
      kind: "image",
      status: "succeeded",
      prompt: "p",
      parameters: {},
      result: { items: [{ storageKey: "image:history" }] },
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    };
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return generationPage([historyJob]);
    }) as typeof fetch;

    await expect(deleteAssetBlobIfUnreferenced("image:history", [], [])).resolves.toBeUndefined();
    expect(requests.some((url) => url.includes("/api/blobs/"))).toBe(false);
  });

  test("deletes an unreferenced image or media blob after collecting generation history", async () => {
    useBoardStore.setState({ projectsState: "loaded", projects: [projectWithStorage()] });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).includes("generation-jobs")) return generationPage();
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(deleteAssetBlobIfUnreferenced("image:orphan", [], [])).resolves.toBeUndefined();
    await expect(deleteAssetBlobIfUnreferenced("media:orphan", [], [])).resolves.toBeUndefined();
    expect(requests.filter(({ url }) => url.includes("/api/blobs/")).map(({ url }) => url)).toEqual([
      "/api/blobs/image%3Aorphan",
      "/api/blobs/media%3Aorphan",
    ]);
  });

  test("uses caller projects only after a lazy load reports loaded", async () => {
    const fallback = projectWithStorage("image:fallback");
    useBoardStore.setState({
      projectsState: "idle",
      projects: [],
      loadProjectsOnDemand: async () => {
        useBoardStore.setState({ projectsState: "loaded" });
      },
    });
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return generationPage();
    }) as typeof fetch;

    await expect(deleteAssetBlobIfUnreferenced("image:fallback", [fallback], [])).resolves.toBeUndefined();
    expect(requests.some((url) => url.includes("/api/blobs/"))).toBe(false);
  });

  test("stops when project loading leaves the store in a non-loaded state", async () => {
    const fetchMock = mock(async () => generationPage());
    globalThis.fetch = fetchMock as typeof fetch;
    useBoardStore.setState({
      projectsState: "idle",
      loadProjectsOnDemand: async () => {
        useBoardStore.setState({ projectsState: "error" });
      },
    });

    await expect(deleteAssetBlobIfUnreferenced("image:unavailable", [], [])).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
