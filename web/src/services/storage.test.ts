import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  blobToDataUrl,
  collectBoardContentStorageKeys,
  collectStorageKeys,
  cropImageToBlob,
  deleteBlob,
  deleteProjectsById,
  deleteStorageKey,
  downloadStorageKey,
  getBlob,
  hasConfigSecrets,
  loadAssets,
  loadConfig,
  loadProjects,
  loadPrompts,
  MEDIA_UPLOAD_LIMITS,
  mergeConfigSecrets,
  putBlob,
  repairInvalidPanoramaBatches,
  rehydrateAssets,
  rehydrateProjects,
  replaceProjects,
  resetStorageScopeState,
  resolveObjectUrl,
  resolveHydratedMediaUrl,
  rotateImageToBlob,
  saveAssets,
  saveConfig,
  saveProjects,
  savePrompts,
  sanitizeConfigForPersistence,
  storageKeyToDataUrl,
  storeImportedMedia,
  uploadMedia,
  validatePersistedPanoramaBlob,
} from "./storage";
import type { AppConfig, AssetItem, BoardProject, PromptItem } from "@/types/board";
import { createDefaultConfig, createEmptySession, createNode, createProject } from "@/lib/defaults";
import { loadServerConfigBundle, resetServerStateVersions, SecretAuthRequiredError } from "./server-storage";

const originalFetch = globalThis.fetch;
const testCredential = (label: string) => `${label}-test-credential`;

afterEach(() => {
  resetStorageScopeState();
  resetServerStateVersions();
  globalThis.fetch = originalFetch;
});

function apiPath(input: RequestInfo | URL): string {
  return new URL(String(input), "http://openboard.test").pathname.replace(/^\/api\//, "");
}

function methodOf(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function installGlobal(name: string, value: unknown): () => void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (prior) Object.defineProperty(globalThis, name, prior);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

function makeProject(id: string, title = id): BoardProject {
  const project = createProject(title);
  return { ...project, id };
}

function makeConfig(): AppConfig {
  const config = createDefaultConfig();
  const channel = config.channels[0]!;
  return {
    ...config,
    channels: [{
      ...channel,
      id: "main",
      apiKey: "legacy-key",
      providers: {
        ...channel.providers!,
        text: { ...channel.providers!.text, apiKey: "text-key" },
        image: { ...channel.providers!.image, apiKey: "image-key" },
        video: { ...channel.providers!.video, apiKey: "video-key" },
        audio: { ...channel.providers!.audio, apiKey: "audio-key" },
      },
    }],
    activeChannelId: "main",
    webdavPass: "dav-key",
    objectStorage: {
      ...config.objectStorage!,
      enabled: true,
      endpoint: "https://storage.example",
      bucket: "bucket",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      sessionToken: "session-token",
    },
  };
}

function makeConfigWithoutSecrets(): AppConfig {
  const config = makeConfig();
  return {
    ...config,
    channels: config.channels.map((channel) => ({
      ...channel,
      apiKey: "",
      providers: Object.fromEntries(Object.entries(channel.providers!).map(([kind, provider]) => [kind, { ...provider, apiKey: "" }])) as NonNullable<typeof channel.providers>,
    })),
    webdavPass: "",
    objectStorage: { ...config.objectStorage!, accessKeyId: "", secretAccessKey: "", sessionToken: "" },
  };
}

const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const tinyVideo = "data:video/mp4;base64,dmlkZW8=";

class ImmediateImage {
  naturalWidth = 64;
  naturalHeight = 32;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

class FailingImage {
  naturalWidth = 0;
  naturalHeight = 0;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

function installImageEnvironment(imageConstructor: typeof ImmediateImage | typeof FailingImage): () => void {
  const restoreImage = installGlobal("Image", imageConstructor);
  const restoreWindow = installGlobal("window", {
    setTimeout,
    clearTimeout,
  });
  return () => {
    restoreWindow();
    restoreImage();
  };
}

function installFileReader(mode: "success" | "error"): () => void {
  class TestFileReader {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    readAsDataURL(blob: Blob): void {
      if (mode === "error") {
        this.error = new Error("reader failed");
        queueMicrotask(() => this.onerror?.());
        return;
      }
      void blob.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        this.result = `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
        this.onload?.();
      });
    }
  }
  return installGlobal("FileReader", TestFileReader);
}

describe("config credential persistence", () => {
  test("does not treat empty per-provider credential maps as persisted secrets", () => {
    expect(hasConfigSecrets({
      apiKeys: { channel: { text: "", image: "", video: "", audio: "" } },
      webdavPass: "",
      objectStorageAccessKeyId: "",
      objectStorageSecretAccessKey: "",
      objectStorageSessionToken: "",
    })).toBe(false);
  });

	test("does not let sanitized empty keys overwrite encrypted server secrets", () => {
		expect(mergeConfigSecrets(
			{ apiKeys: { channel: { image: testCredential("encrypted-image") } }, webdavPass: testCredential("encrypted-dav"), objectStorageAccessKeyId: testCredential("s3-ak"), objectStorageSecretAccessKey: testCredential("s3-sk"), objectStorageSessionToken: "" },
			{ apiKeys: { channel: { image: "", text: testCredential("legacy-text") } }, webdavPass: "", objectStorageAccessKeyId: "", objectStorageSecretAccessKey: "", objectStorageSessionToken: testCredential("s3-tok") },
		)).toEqual({
			apiKeys: { channel: { image: testCredential("encrypted-image"), text: testCredential("legacy-text") } },
			webdavPass: testCredential("encrypted-dav"),
			objectStorageAccessKeyId: testCredential("s3-ak"),
			objectStorageSecretAccessKey: testCredential("s3-sk"),
			objectStorageSessionToken: testCredential("s3-tok"),
		});
	});

  test("removes provider and WebDAV secrets without mutating live config", () => {
    const config: AppConfig = {
      channels: [{
        id: "channel",
        name: "Provider",
        timeoutSeconds: 95,
        baseUrl: "https://api.example/v1",
        apiKey: testCredential("legacy"),
        defaultTextModel: "text",
        defaultImageModel: "image",
        defaultVideoModel: "video",
        providers: {
          text: { baseUrl: "https://text.example/v1", apiKey: testCredential("text"), model: "text" },
          image: { baseUrl: "https://image.example/v1", apiKey: testCredential("image"), model: "image" },
          video: { baseUrl: "https://video.example/v1", apiKey: testCredential("video"), model: "video" },
          audio: { baseUrl: "https://audio.example/v1", apiKey: testCredential("audio"), model: "audio" },
        },
      }],
      activeChannelId: "channel",
      imageSize: "1024x1024",
      imageQuality: "auto",
      imageCount: 1,
      preferredModels: { channel: { image: "image-v2", video: "video-v2" } },
      theme: "dark",
      webdavUrl: "https://dav.example",
      webdavUser: "user",
      webdavPass: "dav-secret",
      objectStorage: {
        enabled: true,
        endpoint: "https://account.r2.cloudflarestorage.com",
        bucket: "openboard-media",
        region: "auto",
        prefix: "openboard",
        accessKeyId: testCredential("s3-ak"),
        secretAccessKey: testCredential("s3-sk"),
        sessionToken: testCredential("s3-tok"),
        allowInsecureLoopback: false,
      },
    };

    const persisted = sanitizeConfigForPersistence(config);
    expect(persisted.channels[0]?.apiKey).toBe("");
    expect(Object.values(persisted.channels[0]?.providers ?? {}).every((provider) => provider.apiKey === "")).toBe(true);
    expect(persisted.channels[0]?.providers?.image.baseUrl).toBe("https://image.example/v1");
    expect(persisted.channels[0]?.timeoutSeconds).toBe(95);
    expect(persisted.webdavPass).toBe("");
    expect(persisted.objectStorage?.accessKeyId).toBe("");
    expect(persisted.objectStorage?.secretAccessKey).toBe("");
    expect(persisted.objectStorage?.sessionToken).toBe("");
    expect(persisted.objectStorage?.endpoint).toBe("https://account.r2.cloudflarestorage.com");
    expect(persisted.preferredModels).toEqual({ channel: { image: "image-v2", video: "video-v2" } });
    expect(config.channels[0]?.apiKey).toBe(testCredential("legacy"));
    expect(config.channels[0]?.timeoutSeconds).toBe(95);
    expect(config.webdavPass).toBe("dav-secret");
    expect(config.objectStorage?.secretAccessKey).toBe(testCredential("s3-sk"));
  });
});

describe("retained board media", () => {
  test("keeps the project fallback when one persisted media request fails", async () => {
    await expect(resolveHydratedMediaUrl(
      "blob:previous-session-preview",
      async () => {
        throw new TypeError("Failed to fetch");
      },
    )).resolves.toBe("blob:previous-session-preview");
  });

  test("collects node and chat media from history-shaped snapshots", () => {
    const node = createNode("panorama", { x: 0, y: 0 }, { metadata: {
      storageKey: "image:panorama-old",
      referenceStorageKeys: ["image:reference"],
    } });
    const session = createEmptySession("History");
    session.messages = [{
      id: "message-1",
      role: "assistant",
      mode: "image",
      text: "result",
      images: [{ id: "image-1", url: "blob:result", storageKey: "image:chat" }],
    }];

    expect([...collectBoardContentStorageKeys([node], [session])].sort()).toEqual([
      "image:chat",
      "image:panorama-old",
      "image:reference",
    ]);
  });

  test("collects preview thumbnails with the durable media they belong to", () => {
    const node = createNode("video", { x: 0, y: 0 }, { metadata: {
      storageKey: "media:clip",
      thumbnailStorageKey: "image:clip-poster",
    } });
    const session = createEmptySession("History");

    expect([...collectBoardContentStorageKeys([node], [session])].sort()).toEqual([
      "image:clip-poster",
      "media:clip",
    ]);
    expect([...collectStorageKeys([{
      id: "board",
      title: "board",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      nodes: [node],
      edges: [],
      chatSessions: [session],
      activeChatId: session.id,
      backgroundMode: "dots" as const,
      viewport: { x: 0, y: 0, k: 1 },
    }], [{
      id: "asset-1",
      kind: "image",
      title: "asset",
      tags: [],
      storageKey: "image:asset",
      thumbnailStorageKey: "image:asset-thumb",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }])].sort()).toEqual([
      "image:asset",
      "image:asset-thumb",
      "image:clip-poster",
      "media:clip",
    ]);
  });

  test("recovers a missing storage object from its embedded image fallback", async () => {
    const fallback = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const project = {
      id: "recover-media",
      title: "recover-media",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      nodes: [createNode("image", { x: 0, y: 0 }, { metadata: {
        storageKey: "image:missing",
        content: fallback,
      } })],
      edges: [],
      chatSessions: [],
      activeChatId: null,
      backgroundMode: "dots" as const,
      viewport: { x: 0, y: 0, k: 1 },
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/media/references")) return new Response("missing", { status: 404 });
      if (method === "GET" && url.includes("/api/blobs/image%3Amissing")) {
        return new Response("missing", { status: 404 });
      }
      if (method === "PUT" && url.includes("/api/blobs/")) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const [rehydrated] = await rehydrateProjects([project]);
    const metadata = rehydrated!.nodes[0]!.metadata;
    expect(metadata.storageKey).toStartWith("image:");
    expect(metadata.storageKey).not.toBe("image:missing");
    expect(metadata.content).not.toBe(fallback);
  });
});

describe("persisted panorama validation", () => {
  test("checks the actual file header against persisted MIME, bytes, and dimensions", async () => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    new DataView(bytes.buffer).setUint32(16, 2048, false);
    new DataView(bytes.buffer).setUint32(20, 1024, false);
    const blob = new Blob([bytes], { type: "image/png" });

    await expect(validatePersistedPanoramaBlob({
      bytes: blob.size,
      mimeType: "image/png",
      naturalWidth: 2048,
      naturalHeight: 1024,
    }, blob)).resolves.toEqual({ width: 2048, height: 1024 });
    await expect(validatePersistedPanoramaBlob({
      bytes: blob.size,
      mimeType: "image/png",
      naturalWidth: 4096,
      naturalHeight: 2048,
    }, blob)).rejects.toThrow("metadata mismatch");
    await expect(validatePersistedPanoramaBlob({
      bytes: blob.size,
      mimeType: "image/webp",
      naturalWidth: 2048,
      naturalHeight: 1024,
    }, blob)).rejects.toThrow("metadata mismatch");
  });

  test("atomically detaches damaged batch children and clears an unusable root batch", () => {
    const root = createNode("panorama", { x: 0, y: 0 }, { id: "root", metadata: {
      content: "blob:root",
      storageKey: "image:root",
      bytes: 100,
      panoramaProjection: "equirectangular",
      isBatchRoot: true,
      batchChildIds: ["valid", "damaged"],
      primaryImageId: "root",
    } });
    const valid = createNode("panorama", { x: 1, y: 0 }, { id: "valid", metadata: {
      content: "blob:valid",
      storageKey: "image:valid",
      bytes: 100,
      panoramaProjection: "equirectangular",
      batchRootId: "root",
    } });
    const damaged = createNode("panorama", { x: 2, y: 0 }, { id: "damaged", metadata: {
      storageKey: "image:damaged",
      bytes: 100,
      panoramaProjection: "equirectangular",
      batchRootId: "root",
    } });

    const repaired = repairInvalidPanoramaBatches([root, valid, damaged]);
    expect(repaired.find((node) => node.id === "root")?.metadata.batchChildIds).toEqual(["valid"]);
    expect(repaired.find((node) => node.id === "damaged")?.metadata.batchRootId).toBeUndefined();

    const brokenRoot = repairInvalidPanoramaBatches([
      { ...root, metadata: { ...root.metadata, content: undefined } },
      valid,
    ]);
    expect(brokenRoot[0]?.metadata.isBatchRoot).toBeUndefined();
    expect(brokenRoot[1]?.metadata.batchRootId).toBeUndefined();
  });
});

describe("remote media upload limits", () => {
  test("never returns a storage key when persistent upload fails", async () => {
    globalThis.fetch = mock(async () => new Response("storage unavailable", { status: 500 })) as typeof fetch;

    await expect(uploadMedia(new Blob(["image"], { type: "image/png" }), "image"))
      .rejects.toThrow("Blob save failed: HTTP 500");
  });

  test("rejects an image whose declared size exceeds the upload limit", async () => {
    globalThis.fetch = mock(async () => new Response("", {
      headers: {
        "content-length": String(MEDIA_UPLOAD_LIMITS.imageBytes + 1),
        "content-type": "image/png",
      },
    })) as typeof fetch;

    await expect(uploadMedia("https://media.example/huge.png", "image"))
      .rejects.toThrow("too large");
  });

  test("rejects MIME mismatches before persisting the response", async () => {
    globalThis.fetch = mock(async () => new Response("not an image", {
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

    await expect(uploadMedia("https://media.example/not-image", "image"))
      .rejects.toThrow("MIME");
  });

  test("rejects active SVG content from remote image URLs", async () => {
    globalThis.fetch = mock(async () => new Response("<svg></svg>", {
      headers: { "content-type": "image/svg+xml" },
    })) as typeof fetch;

    await expect(uploadMedia("https://media.example/image.svg", "image"))
      .rejects.toThrow("MIME");
  });

  test("omits credentials and refuses redirects for external media", async () => {
    let init: RequestInit | undefined;
    let requested = "";
    globalThis.fetch = mock(async (input, requestInit) => {
      requested = String(input);
      init = requestInit;
      return new Response(null, {
        headers: {
          "content-type": "image/png",
          "content-length": String(MEDIA_UPLOAD_LIMITS.imageBytes + 1),
        },
      });
    }) as typeof fetch;

    await expect(uploadMedia("https://media.example/image.png?X-Amz-Signature=abc", "image")).rejects.toThrow("too large");
    expect(requested).toContain("X-Amz-Signature=abc");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.referrerPolicy).toBe("no-referrer");
    await expect(uploadMedia("https://127.0.0.1/image.png", "image")).rejects.toThrow("private");
  });
});

describe("guest capability model for config secrets", () => {
  test("empty secret bag 401 does not block non-secret config persistence contract", async () => {
    // Product rule: guests may save prompt-source config. Secrets require login.
    // Empty bags + 401 must soft-fail; real credentials must fail closed.
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && String(input).includes("config")) {
        return Response.json({
          config: { channels: [] },
          secrets: { apiKeys: {}, webdavPass: "" },
        }, { headers: { ETag: '"cfg-1"' } });
      }
      return new Response("login required", { status: 401 });
    }) as typeof fetch;
    const { saveServerSecrets } = await import("./server-storage");
    await loadServerConfigBundle();
    await expect(saveServerSecrets({ apiKeys: {}, webdavPass: "" })).rejects.toBeInstanceOf(SecretAuthRequiredError);
    await expect(saveServerSecrets({
      apiKeys: { main: { image: "sk-test" } },
      webdavPass: "",
    })).rejects.toBeInstanceOf(SecretAuthRequiredError);
  });
});

describe("remote project and prompt persistence", () => {
  test("loads, saves, deletes, and replaces projects through the remote catalog", async () => {
    const loaded = makeProject("loaded", "Loaded");
    const replacement = makeProject("replacement", "Replacement");
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    let catalogReads = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      requests.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (path === "projects" && method === "GET") {
        catalogReads += 1;
        return Response.json(catalogReads === 1 ? [{ id: "loaded" }] : [{ id: "old" }]);
      }
      if (path === "projects/loaded" && method === "GET") return Response.json(loaded);
      if (path === "projects/replacement" && method === "PUT") return new Response(null, { status: 200 });
      if (path === "projects/gone" && method === "PUT") return new Response("gone", { status: 410 });
      if (path === "projects/old" && method === "DELETE") return new Response(null, { status: 204 });
      if (path === "projects/removed" && method === "DELETE") return new Response(null, { status: 204 });
      return new Response(`unexpected ${method} ${path}`, { status: 500 });
    }) as typeof fetch;

    await expect(loadProjects()).resolves.toEqual([loaded]);
    await expect(saveProjects([replacement, makeProject("gone")])).resolves.toEqual(["gone"]);
    await deleteProjectsById(["removed", "", "removed"]);
    await deleteProjectsById([]);
    await replaceProjects([replacement]);

    expect(requests.filter((request) => request.path === "projects/removed")).toHaveLength(1);
    expect(requests.filter((request) => request.path === "projects/old" && request.method === "DELETE")).toHaveLength(1);
    expect(requests.some((request) => request.path === "projects/replacement" && request.method === "PUT")).toBe(true);
    const replacementBody = requests.find((request) => request.path === "projects/replacement")?.body;
    expect(replacementBody).toContain('"id":"replacement"');
  });

  test("uses empty defaults for missing assets/prompts and strips transient thumbnails on save", async () => {
    const savedAssets: AssetItem[] = [{
      id: "asset-1",
      kind: "image",
      title: "asset",
      tags: [],
      storageKey: "image:asset",
      thumbnailUrl: "blob:thumbnail",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }];
    const savedPrompts: PromptItem[] = [{
      id: "prompt-1",
      title: "Prompt",
      body: "body",
      tags: [],
      source: "test",
    }];
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      requests.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (path === "state/assets" && method === "GET") return new Response(null, { status: 404 });
      if (path === "state/prompts" && method === "GET") return Response.json(savedPrompts);
      if (path === "state/assets" && method === "PUT") return new Response(null, { status: 204 });
      if (path === "state/prompts" && method === "PUT") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    await expect(loadAssets()).resolves.toEqual([]);
    await expect(loadPrompts()).resolves.toEqual(savedPrompts);
    await saveAssets(savedAssets);
    await savePrompts(savedPrompts);

    const assetBody = requests.find((request) => request.path === "state/assets" && request.method === "PUT")?.body;
    expect(assetBody).toContain('"storageKey":"image:asset"');
    expect(assetBody).not.toContain("thumbnailUrl");
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(2);
  });
});

describe("config load and save capability branches", () => {
  test("hydrates encrypted credentials and persists a sanitized catalog", async () => {
    const stored = makeConfig();
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      requests.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (path === "config" && method === "GET") {
        return Response.json({
          config: stored,
          secrets: {
            apiKeys: { main: { text: "session-text", audio: "session-audio" } },
            webdavPass: "session-dav",
            objectStorageAccessKeyId: "session-access",
            objectStorageSecretAccessKey: "session-secret",
            objectStorageSessionToken: "session-token",
          },
        }, { headers: { ETag: '"cfg-1"' } });
      }
      if (path === "state/config" && method === "PUT") {
        return new Response(null, { status: 200, headers: { ETag: '"cfg-2"' } });
      }
      return new Response(`unexpected ${method} ${path}`, { status: 500 });
    }) as typeof fetch;

    const hydrated = await loadConfig();
    expect(hydrated?.channels[0]?.providers?.text.apiKey).toBe("text-key");
    expect(hydrated?.channels[0]?.providers?.image.apiKey).toBe("image-key");
    expect(hydrated?.channels[0]?.apiKey).toBe("text-key");
    expect(hydrated?.webdavPass).toBe("dav-key");
    expect(hydrated?.objectStorage?.accessKeyId).toBe("access-key");
    expect(hydrated?.objectStorage?.secretAccessKey).toBe("secret-key");
    expect(hydrated?.objectStorage?.sessionToken).toBe("session-token");

    const persistedBody = requests.find((request) => request.path === "state/config" && request.method === "PUT")?.body;
    expect(persistedBody).toBeDefined();
    expect(persistedBody).not.toContain("text-key");
    expect(persistedBody).not.toContain("secret-key");
    expect(persistedBody).toContain('"webdavPass":""');
  });

  test("falls back to secret-free state when the config bundle requires auth and returns null when absent", async () => {
    const fallback = makeConfig();
    fallback.channels = fallback.channels.map((channel) => ({
      ...channel,
      apiKey: "",
      providers: Object.fromEntries(Object.entries(channel.providers!).map(([kind, provider]) => [kind, { ...provider, apiKey: "" }])) as NonNullable<typeof channel.providers>,
    }));
    fallback.webdavPass = "";
    fallback.objectStorage = { ...fallback.objectStorage!, accessKeyId: "", secretAccessKey: "", sessionToken: "" };
    let bundleStatus = 401;
    let stateStatus = 200;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      if (path === "config" && method === "GET") return new Response("login", { status: bundleStatus });
      if (path === "state/config" && method === "GET") {
        return stateStatus === 404
          ? new Response(null, { status: 404 })
          : Response.json(fallback, { headers: { ETag: '"fallback"' } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    await expect(loadConfig()).resolves.toMatchObject({ channels: [{ id: "main" }], webdavPass: "" });
    bundleStatus = 403;
    await expect(loadConfig()).resolves.toMatchObject({ channels: [{ id: "main" }] });
    stateStatus = 404;
    await expect(loadConfig()).resolves.toBeNull();
  });

  test("rethrows non-auth load failures and tolerates tenant-forbidden migration writes", async () => {
    globalThis.fetch = mock(async () => new Response("broken", { status: 500 })) as typeof fetch;
    await expect(loadConfig()).rejects.toThrow("Config load failed: HTTP 500");

    const stored = makeConfig();
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      if (path === "config" && method === "GET") {
        return Response.json({ config: stored, secrets: { apiKeys: {}, webdavPass: "" } }, { headers: { ETag: '"cfg"' } });
      }
      if (path === "state/config" && method === "PUT") return new Response("forbidden", { status: 403 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    await expect(loadConfig()).resolves.toBeTruthy();
  });

  test("saves credentialed config as one bundle and falls back for secret-free guests", async () => {
    const secretful = makeConfig();
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    let bundleStatus = 200;
    let guestFallback = false;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      requests.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (path === "config" && method === "GET") return new Response(null, { status: 404 });
      if (path === "config" && method === "PUT") {
        return bundleStatus === 200
          ? new Response(null, { status: 200, headers: { ETag: '"saved"' } })
          : new Response("login", { status: 401 });
      }
      if (path === "state/config" && method === "PUT") {
        guestFallback = true;
        return new Response(null, { status: 200, headers: { ETag: '"guest"' } });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    // A 404 establishes the initial If-None-Match version for a new tenant.
    await loadServerConfigBundle();
    await saveConfig(secretful);
    const bundleBody = requests.find((request) => request.path === "config" && request.method === "PUT")?.body;
    const parsedBundle = JSON.parse(bundleBody!);
    expect(parsedBundle.config.channels[0].providers.text.apiKey).toBe("");
    expect(parsedBundle.secrets.apiKeys.main.text).toBe("text-key");

    resetStorageScopeState();
    bundleStatus = 404;
    await loadServerConfigBundle();
    await saveConfig(makeConfigWithoutSecrets());
    expect(guestFallback).toBe(true);

    resetStorageScopeState();
    bundleStatus = 404;
    await loadServerConfigBundle();
    await expect(saveConfig(secretful)).rejects.toBeInstanceOf(SecretAuthRequiredError);
  });
});

describe("remote blob lifecycle", () => {
  test("puts, reads, caches, converts, and removes image/media blobs", async () => {
    const stored = new Blob(["hello"], { type: "text/plain" });
    let deleted = false;
    const requests: Array<{ path: string; method: string }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      requests.push({ path, method });
      if (path.startsWith("blobs/") && method === "PUT") return new Response(null, { status: 204 });
      if (path.startsWith("blobs/") && method === "GET") {
        return deleted ? new Response(null, { status: 404 }) : new Response(stored);
      }
      if (path.startsWith("blobs/") && method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    await putBlob("image", "image:cached", stored);
    await expect(getBlob("image", "image:cached")).resolves.toEqual(stored);
    const firstUrl = await resolveObjectUrl("image", "image:cached");
    const secondUrl = await resolveObjectUrl("media", "image:cached", "blob:fallback");
    expect(firstUrl).toBeDefined();
    expect(secondUrl).toBe(firstUrl);

    const restoreReader = installFileReader("success");
    await expect(storageKeyToDataUrl("image", "image:cached")).resolves.toBe("data:text/plain;charset=utf-8;base64,aGVsbG8=");
    restoreReader();

    await deleteBlob("image", "image:cached");
    await expect(resolveObjectUrl("image", "image:cached", "blob:fallback")).resolves.toBe("blob:fallback");
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  test("propagates remote errors and honors cancellation before upload starts", async () => {
    let calls = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const path = apiPath(input);
      const method = methodOf(init);
      if (path.startsWith("blobs/") && method === "GET") return new Response("broken", { status: 500 });
      if (path.startsWith("blobs/") && method === "DELETE") return new Response("broken", { status: 500 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(getBlob("image", "image:broken")).rejects.toThrow("Blob read failed: HTTP 500");
    await expect(deleteBlob("media", "media:broken")).rejects.toThrow("Blob delete failed: HTTP 500");
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await expect(putBlob("media", "media:cancelled", new Blob(["x"]), controller.signal))
      .rejects.toThrow("cancelled by test");
    expect(calls).toBe(2);
  });

  test("retries a throttled blob upload using the server retry hint", async () => {
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } })
        : new Response(null, { status: 204 });
    }) as typeof fetch;

    await putBlob("image", "image:retry", new Blob(["x"], { type: "image/png" }));
    expect(attempts).toBe(2);
  });
});

describe("media import and upload behavior", () => {
  test("stores imported audio with durable metadata and rejects both kind limits", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: apiPath(input), method: methodOf(init) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const audio = new Blob(["audio"], { type: "audio/mpeg" });
    const result = await storeImportedMedia("media", audio);
    expect(result.storageKey).toStartWith("media:");
    expect(result.url).toStartWith("blob:");
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.bytes).toBe(audio.size);
    expect(result.mimeType).toBe("audio/mpeg");

    const oversizedImage = new Blob(["x"]);
    Object.defineProperty(oversizedImage, "size", { value: MEDIA_UPLOAD_LIMITS.imageBytes + 1 });
    await expect(storeImportedMedia("image", oversizedImage)).rejects.toThrow("Media is too large");
    const oversizedMedia = new Blob(["x"]);
    Object.defineProperty(oversizedMedia, "size", { value: MEDIA_UPLOAD_LIMITS.mediaBytes + 1 });
    await expect(storeImportedMedia("media", oversizedMedia)).rejects.toThrow("Media is too large");
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  test("reads imported image dimensions and removes the server blob if preview creation fails", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: apiPath(input), method: methodOf(init) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const restoreImage = installImageEnvironment(ImmediateImage);
    const result = await storeImportedMedia("image", new Blob(["image"], { type: "image/png" }));
    restoreImage();
    expect(result.width).toBe(64);
    expect(result.height).toBe(32);

    const restoreFailingImage = installImageEnvironment(FailingImage);
    await expect(storeImportedMedia("image", new Blob(["broken"], { type: "image/png" }))).rejects.toThrow("Failed to read image size");
    restoreFailingImage();
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  test("accepts data/blob/http media inputs and applies preflight dimensions", async () => {
    const requests: Array<{ input: string; path: string; method: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputText = String(input);
      const path = apiPath(input);
      const method = methodOf(init);
      requests.push({ input: inputText, path, method, init });
      if (inputText === "blob:source") {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      if (inputText.startsWith("https://media.example/")) {
        return new Response(new Uint8Array([4, 5]), { headers: { "content-type": "video/mp4" } });
      }
      if (path.startsWith("blobs/") && method === "PUT") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const dimensions = { width: 120, height: 80 };
    const preflight = async (blob: Blob, signal?: AbortSignal) => {
      expect(blob.type).toBe("image/png");
      expect(signal).toBeUndefined();
      return dimensions;
    };

    const dataUpload = await uploadMedia(onePixelPng, "image", { preflightImage: preflight, validateLargeImage: true });
    const blobUpload = await uploadMedia("blob:source", "image", { preflightImage: preflight });
    const remoteUpload = await uploadMedia("https://media.example/clip.mp4", "media");
    expect(dataUpload.width).toBe(120);
    expect(dataUpload.height).toBe(80);
    expect(blobUpload.bytes).toBe(3);
    expect(remoteUpload.mimeType).toBe("video/mp4");
    expect(requests.some((request) => request.input === "blob:source")).toBe(true);
    expect(requests.find((request) => request.input.startsWith("https://media.example/"))?.init?.credentials).toBe("omit");
  });

  test("rejects unsupported and oversized inputs, and preserves zero dimensions for unreadable images", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (apiPath(input).startsWith("blobs/") && methodOf(init) === "PUT") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    await expect(uploadMedia("ftp://media.example/file.png", "image")).rejects.toThrow("Unsupported media input");
    await expect(uploadMedia("data:text/plain;base64,eA==", "image")).rejects.toThrow("Unsupported data URL MIME type");
    const oversized = new Blob(["x"], { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: MEDIA_UPLOAD_LIMITS.imageBytes + 1 });
    await expect(uploadMedia(oversized, "image")).rejects.toThrow("Media is too large");

    const restoreImage = installImageEnvironment(FailingImage);
    const uploaded = await uploadMedia(new Blob(["not-an-image"], { type: "image/png" }), "image");
    restoreImage();
    expect(uploaded.width).toBe(0);
    expect(uploaded.height).toBe(0);
  });

  test("falls back to a data URL when object URLs are unavailable, or cleans up persistent uploads", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      requests.push({ path, method });
      if (path.startsWith("blobs/") && method === "PUT") return new Response(null, { status: 204 });
      if (path.startsWith("blobs/") && method === "DELETE") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const restoreReader = installFileReader("success");
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = (() => { throw new Error("object URLs unavailable"); }) as typeof URL.createObjectURL;
    try {
      const fallback = await uploadMedia(new Blob(["abc"], { type: "audio/mpeg" }), "media");
      expect(fallback.url).toBe("data:audio/mpeg;base64,YWJj");

      await expect(uploadMedia(new Blob(["persistent"], { type: "audio/mpeg" }), "media", { requirePersistent: true }))
        .rejects.toThrow("object URLs unavailable");
    } finally {
      URL.createObjectURL = originalCreate;
      restoreReader();
    }
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  test("reports cleanup failure when persistent URL creation and blob deletion both fail", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      if (path.startsWith("blobs/") && method === "PUT") return new Response(null, { status: 204 });
      if (path.startsWith("blobs/") && method === "DELETE") return new Response("no delete", { status: 500 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = (() => { throw new Error("object URLs unavailable"); }) as typeof URL.createObjectURL;
    try {
      await expect(uploadMedia(new Blob(["persistent"], { type: "audio/mpeg" }), "media", { requirePersistent: true }))
        .rejects.toThrow("stored blob cleanup failed");
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });
});

describe("storage URL utilities and image transforms", () => {
  test("downloads media through an anchor and deletes cached media by key prefix", async () => {
    const blob = new Blob(["clip"], { type: "video/mp4" });
    const anchors: Array<{ href?: string; download?: string; clicks: number }> = [];
    const restoreDocument = installGlobal("document", {
      createElement(tag: string) {
        if (tag !== "a") throw new Error(`unexpected element ${tag}`);
        const anchor = { clicks: 0, click() { this.clicks += 1; } };
        anchors.push(anchor);
        return anchor;
      },
    });
    let deleted = false;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = apiPath(input);
      const method = methodOf(init);
      if (path.startsWith("blobs/") && method === "GET") {
        return deleted ? new Response(null, { status: 404 }) : new Response(blob);
      }
      if (path.startsWith("blobs/") && method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      await downloadStorageKey("media:clip", "clip.mp4");
      expect(anchors[0]?.download).toBe("clip.mp4");
      expect(anchors[0]?.href).toStartWith("blob:");
      expect(anchors[0]?.clicks).toBe(1);

      await resolveObjectUrl("media", "media:cached", "blob:fallback");
      await deleteStorageKey("media:cached");
      await expect(downloadStorageKey("image:missing", "missing.png")).rejects.toThrow("文件不存在");
    } finally {
      restoreDocument();
    }
  });

  test("crops and rotates loaded images, including canvas and image failures", async () => {
    const drawCalls: unknown[][] = [];
    const translations: unknown[][] = [];
    const rotations: number[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args: unknown[]) => drawCalls.push(args),
        translate: (...args: unknown[]) => translations.push(args),
        rotate: (value: number) => rotations.push(value),
      }),
      toBlob: (callback: (value: Blob | null) => void) => callback(new Blob(["png"], { type: "image/png" })),
    };
    const restoreDocument = installGlobal("document", { createElement: () => canvas });
    const restoreImage = installImageEnvironment(ImmediateImage);
    try {
      const cropped = await cropImageToBlob("blob:source", { x: 2, y: 3, w: 0.4, h: 2.6 });
      expect(cropped.type).toBe("image/png");
      expect(canvas.width).toBe(1);
      expect(canvas.height).toBe(3);
      expect(drawCalls[0]).toHaveLength(9);

      const rotated = await rotateImageToBlob("blob:source", 90);
      expect(rotated.type).toBe("image/png");
      expect(canvas.width).toBe(32);
      expect(canvas.height).toBe(64);
      expect(translations).toContainEqual([16, 32]);
      expect(rotations[0]).toBeCloseTo(Math.PI / 2);
    } finally {
      restoreImage();
      restoreDocument();
    }
  });

  test("surfaces transform failures instead of returning empty blobs", async () => {
    const noContextCanvas = { width: 1, height: 1, getContext: () => null };
    const restoreDocument = installGlobal("document", { createElement: () => noContextCanvas });
    const restoreImage = installImageEnvironment(ImmediateImage);
    try {
      await expect(cropImageToBlob("blob:source", { x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow("Canvas unavailable");
    } finally {
      restoreImage();
      restoreDocument();
    }

    const failingCanvas = {
      width: 1,
      height: 1,
      getContext: () => ({ drawImage() {}, translate() {}, rotate() {} }),
      toBlob: (callback: (value: Blob | null) => void) => callback(null),
    };
    const restoreFailingDocument = installGlobal("document", { createElement: () => failingCanvas });
    const restoreFailingImage = installImageEnvironment(ImmediateImage);
    try {
      await expect(rotateImageToBlob("blob:source", 0)).rejects.toThrow("Rotate failed");
    } finally {
      restoreFailingImage();
      restoreFailingDocument();
    }

    const restoreBrokenImage = installImageEnvironment(FailingImage);
    try {
      await expect(cropImageToBlob("blob:broken", { x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow("Failed to load image");
    } finally {
      restoreBrokenImage();
    }
  });
});
