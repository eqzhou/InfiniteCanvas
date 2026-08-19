import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  attachPreviewToStoredMedia,
  createMediaPreviewBlob,
  displayMediaNodeFields,
  enrichResultItemsWithPreviews,
  storeMediaPreview,
  uploadDisplayMedia,
} from "./media-preview";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function jpegBlob(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
}

describe("stored media previews", () => {
  test("uploads an encoded preview and returns its durable key", async () => {
    const puts: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT" && url.includes("/api/blobs/")) {
        puts.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const preview = await storeMediaPreview(new Blob(["full-image"], { type: "image/png" }), "image", {
      encode: async () => jpegBlob(),
    });

    expect(preview?.thumbnailStorageKey).toStartWith("image:");
    expect(preview?.thumbnailUrl).toStartWith("blob:");
    expect(puts).toHaveLength(1);
  });

  test("swallows encoder failures so the original media still uploads", async () => {
    const preview = await storeMediaPreview(new Blob(["full-image"], { type: "image/png" }), "image", {
      encode: async () => {
        throw new Error("canvas unavailable");
      },
    });
    expect(preview).toBeUndefined();
  });

  test("does not fail the original when the stored blob cannot be read", async () => {
    globalThis.fetch = mock(async () => new Response("missing", { status: 500 })) as typeof fetch;
    await expect(attachPreviewToStoredMedia("image:source", "image/png")).resolves.toBeUndefined();
  });

  test("attaches a preview to an already stored original", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/api/blobs/image%3Asource")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      if (method === "PUT" && url.includes("/api/blobs/")) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const preview = await attachPreviewToStoredMedia("image:source", "image/png", {
      encode: async () => jpegBlob(),
    });
    expect(preview?.thumbnailStorageKey).toStartWith("image:");
    expect(preview?.thumbnailStorageKey).not.toBe("image:source");
  });
});

describe("display media upload", () => {
  test("keeps the original blob and adds a sibling preview", async () => {
    const puts: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT" && url.includes("/api/blobs/")) {
        puts.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const uploaded = await uploadDisplayMedia(new Blob(["full-image"], { type: "image/png" }), "image", {
      encodePreview: async () => jpegBlob(),
    });

    expect(uploaded.storageKey).toStartWith("image:");
    expect(uploaded.thumbnailStorageKey).toStartWith("image:");
    expect(uploaded.thumbnailStorageKey).not.toBe(uploaded.storageKey);
    expect(puts).toHaveLength(2);
  });

  test("does not create a preview for audio", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const uploaded = await uploadDisplayMedia(new Blob(["sound"], { type: "audio/mpeg" }), "media");
    expect(uploaded.storageKey).toStartWith("media:");
    expect(uploaded.thumbnailStorageKey).toBeUndefined();
  });
});

describe("browser preview encoders and result enrichment", () => {
  test("decodes an image, scales it into a canvas, and closes the bitmap", async () => {
    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const priorBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
    const draws: Array<[unknown, number, number, number, number]> = [];
    let closed = 0;
    let encoded: { width: number; height: number; type: string; quality: number } | undefined;
    const context = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage: (...args: [unknown, number, number, number, number]) => draws.push(args),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: (blob: Blob | null) => void, type: string, quality: number) => {
        encoded = { width: canvas.width, height: canvas.height, type, quality };
        callback(jpegBlob());
      },
    };
    try {
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: async () => ({ width: 1920, height: 1080, close: () => { closed += 1; } }),
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { createElement: (tag: string) => tag === "canvas" ? canvas : undefined },
      });

      const result = await createMediaPreviewBlob(new Blob(["source"], { type: "image/png" }), "image");

      expect(result.type).toBe("image/jpeg");
      expect(encoded).toMatchObject({ width: 640, height: 360, type: "image/jpeg", quality: 0.82 });
      expect(draws).toHaveLength(1);
      expect(draws[0]?.slice(1)).toEqual([0, 0, 640, 360]);
      expect(context.imageSmoothingEnabled).toBe(true);
      expect(context.imageSmoothingQuality).toBe("high");
      expect(closed).toBe(1);
    } finally {
      if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument);
      else delete (globalThis as { document?: Document }).document;
      if (priorBitmap) Object.defineProperty(globalThis, "createImageBitmap", priorBitmap);
      else delete (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
    }
  });

  test("encodes a video poster after loaded data and seek events", async () => {
    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousCreateObjectURL = URL.createObjectURL;
    const previousRevokeObjectURL = URL.revokeObjectURL;
    let revoked = "";
    let canvasSize = { width: 0, height: 0 };
    const context = { drawImage: () => undefined };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: (blob: Blob | null) => void) => {
        canvasSize = { width: canvas.width, height: canvas.height };
        callback(jpegBlob());
      },
    };
    const video: {
      muted: boolean;
      playsInline: boolean;
      preload: string;
      duration: number;
      videoWidth: number;
      videoHeight: number;
      onloadeddata?: () => void;
      onerror?: () => void;
      onseeked?: () => void;
      src: string;
      currentTime: number;
      removeAttribute: (name: string) => void;
      load: () => void;
    } = {
      muted: false,
      playsInline: false,
      preload: "",
      duration: 4,
      videoWidth: 1280,
      videoHeight: 720,
      src: "",
      currentTime: 0,
      removeAttribute: () => undefined,
      load: () => undefined,
    };
    Object.defineProperty(video, "src", {
      configurable: true,
      get: () => "blob:video-source",
      set: () => queueMicrotask(() => video.onloadeddata?.()),
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 0.1,
      set: () => queueMicrotask(() => video.onseeked?.()),
    });
    try {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:video-source" });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: (url: string) => { revoked = url; } });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { setTimeout, clearTimeout },
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { createElement: (tag: string) => tag === "video" ? video : canvas },
      });

      const result = await createMediaPreviewBlob(new Blob(["source"], { type: "video/mp4" }), "video");

      expect(result.type).toBe("image/jpeg");
      expect(video.muted).toBe(true);
      expect(video.playsInline).toBe(true);
      expect(video.preload).toBe("auto");
      expect(canvasSize).toEqual({ width: 640, height: 360 });
      expect(revoked).toBe("blob:video-source");
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: previousCreateObjectURL });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: previousRevokeObjectURL });
      if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument);
      else delete (globalThis as { document?: Document }).document;
      if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
      else delete (globalThis as { window?: Window & typeof globalThis }).window;
    }
  });

  test("enriches only missing previews and leaves failures and existing previews unchanged", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && url.includes("image%3Amissing")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      if ((init?.method ?? "GET") === "PUT") return new Response(null, { status: 204 });
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const existing = { storageKey: "image:existing", thumbnailStorageKey: "image:thumb", thumbnailUrl: "blob:thumb" };
    const missing = { storageKey: "image:missing", mimeType: "image/png" };
    const failed = { storageKey: "image:failed", mimeType: "image/png" };
    const noKey = { mimeType: "image/png" };

    const result = await enrichResultItemsWithPreviews([existing, missing, failed, noKey], {
      encode: async (blob) => blob.size ? jpegBlob() : new Blob(),
    });

    expect(result[0]).toBe(existing);
    expect(result[1]?.thumbnailStorageKey).toStartWith("image:");
    expect(result[2]).toBe(failed);
    expect(result[3]).toBe(noKey);
  });

  test("maps uploaded media fields without exposing the source blob", () => {
    const uploaded = {
      url: "blob:full",
      storageKey: "image:full",
      thumbnailStorageKey: "image:thumb",
      thumbnailUrl: "blob:thumb",
      width: 640,
      height: 480,
      bytes: 123,
      mimeType: "image/jpeg",
    } as Parameters<typeof displayMediaNodeFields>[0];
    expect(displayMediaNodeFields(uploaded)).toEqual({
      content: "blob:full",
      storageKey: "image:full",
      thumbnailStorageKey: "image:thumb",
      thumbnailUrl: "blob:thumb",
      naturalWidth: 640,
      naturalHeight: 480,
      bytes: 123,
      mimeType: "image/jpeg",
    });
  });
});
