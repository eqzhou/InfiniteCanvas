import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  canMintPublicMediaReferences,
  createMediaReferences,
  mediaReferencePublicUrl,
  resolveMediaRefs,
  resolvePublicMediaReferenceUrls,
} from "./media-references";

const originalFetch = globalThis.fetch;
const originalStorage = import.meta.env.VITE_OPENBOARD_STORAGE;

afterEach(() => {
  globalThis.fetch = originalFetch;
  import.meta.env.VITE_OPENBOARD_STORAGE = originalStorage;
});

describe("media reference helpers", () => {
  test("builds absolute public URLs for tokens", () => {
    expect(mediaReferencePublicUrl("tok/1", "https://canvas.example.com")).toBe(
      "https://canvas.example.com/api/media/references/tok%2F1",
    );
  });

  test("only mints when server storage is on a public HTTPS origin", () => {
    import.meta.env.VITE_OPENBOARD_STORAGE = "server";
    expect(canMintPublicMediaReferences("https://canvas.example.com")).toBe(true);
    expect(canMintPublicMediaReferences("http://canvas.example.com")).toBe(false);
    expect(canMintPublicMediaReferences("https://localhost:5173")).toBe(false);
    import.meta.env.VITE_OPENBOARD_STORAGE = "local";
    expect(canMintPublicMediaReferences("https://canvas.example.com")).toBe(false);
  });

  test("createMediaReferences posts storage keys and parses items", async () => {
    let url = "";
    let body = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({
        items: [{ token: "abc", storageKey: "image:1", expiresAt: "2026-07-27T00:00:00Z" }],
        expiresAt: "2026-07-27T00:00:00Z",
      }), { status: 201 });
    }) as typeof fetch;
    const result = await createMediaReferences([" image:1 ", "image:1"]);
    expect(url).toContain("media/references");
    expect(JSON.parse(body)).toEqual({ storageKeys: ["image:1"], ttlSeconds: 900 });
    expect(result.items[0]?.token).toBe("abc");
  });

  test("resolveMediaRefs prefers public URLs over data URLs when minting works", async () => {
    import.meta.env.VITE_OPENBOARD_STORAGE = "server";
    // Force canMint via stubbing location origin through create path: we mock
    // createMediaReferences network and override canMint by monkeypatching window.
    const originalWindow = globalThis.window;
    // @ts-expect-error test stub
    globalThis.window = { location: { origin: "https://canvas.example.com" } };
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).includes("media/references") && !String(input).includes("tok")) {
        return new Response(JSON.stringify({
          items: [{ token: "tok", storageKey: "image:ref", expiresAt: "2026-07-27T00:00:00Z" }],
          expiresAt: "2026-07-27T00:00:00Z",
        }), { status: 201 });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    try {
      const urls = await resolveMediaRefs([{
        storageKey: "image:ref",
        content: "data:image/png;base64,cGl4ZWw=",
      }], 1);
      expect(urls).toEqual(["https://canvas.example.com/api/media/references/tok"]);
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("resolvePublicMediaReferenceUrls returns empty map when minting is unavailable", async () => {
    import.meta.env.VITE_OPENBOARD_STORAGE = "local";
    const map = await resolvePublicMediaReferenceUrls(["image:1"]);
    expect(map.size).toBe(0);
  });
});
