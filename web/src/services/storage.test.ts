import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  collectBoardContentStorageKeys,
  MEDIA_UPLOAD_LIMITS,
	mergeConfigSecrets,
  repairInvalidPanoramaBatches,
  sanitizeConfigForPersistence,
  uploadMedia,
  validatePersistedPanoramaBlob,
} from "./storage";
import type { AppConfig } from "@/types/board";
import { createEmptySession, createNode } from "@/lib/defaults";

const originalFetch = globalThis.fetch;
const testCredential = (label: string) => `${label}-test-credential`;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("config credential persistence", () => {
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
    expect(persisted.webdavPass).toBe("");
    expect(persisted.objectStorage?.accessKeyId).toBe("");
    expect(persisted.objectStorage?.secretAccessKey).toBe("");
    expect(persisted.objectStorage?.sessionToken).toBe("");
    expect(persisted.objectStorage?.endpoint).toBe("https://account.r2.cloudflarestorage.com");
    expect(config.channels[0]?.apiKey).toBe(testCredential("legacy"));
    expect(config.webdavPass).toBe("dav-secret");
    expect(config.objectStorage?.secretAccessKey).toBe(testCredential("s3-sk"));
  });
});

describe("retained board media", () => {
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
    globalThis.fetch = mock(async () => new Response("login required", { status: 401 })) as typeof fetch;
    const { SecretAuthRequiredError, saveServerSecrets } = await import("./server-storage");
    await expect(saveServerSecrets({ apiKeys: {}, webdavPass: "" })).rejects.toBeInstanceOf(SecretAuthRequiredError);
    await expect(saveServerSecrets({
      apiKeys: { main: { image: "sk-test" } },
      webdavPass: "",
    })).rejects.toBeInstanceOf(SecretAuthRequiredError);
  });
});

