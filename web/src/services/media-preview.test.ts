import { afterEach, describe, expect, mock, test } from "bun:test";
import { attachPreviewToStoredMedia, storeMediaPreview, uploadDisplayMedia } from "./media-preview";

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
