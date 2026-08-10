import { describe, expect, mock, test } from "bun:test";

import { listMediaCapabilities, mediaOptionsForKind } from "./media-capabilities";

describe("media capability catalog", () => {
  test("loads a versioned safe catalog and derives exact model options", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "a".repeat(64), models: [{ channelId: "shared-image", channelName: "Images", protocol: "openai", model: "gpt-image-1", kind: "image", modes: ["text_to_image", "image_to_image"], sizes: ["1024x1024"], maxReferences: 16 }] }), { status: 200 })) as typeof fetch;
    const catalog = await listMediaCapabilities();
    expect(mediaOptionsForKind(catalog, "image")).toEqual([{ channelId: "shared-image", channelName: "Images", model: "gpt-image-1", protocol: "openai", modes: ["text_to_image", "image_to_image"], sizes: ["1024x1024"], durations: [], maxReferences: 16 }]);
  });

  test("fails closed for malformed or guessed catalog entries", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "bad", models: [{ channelId: "x", model: "unknown", kind: "image", modes: ["magic"] }] }), { status: 200 })) as typeof fetch;
    await expect(listMediaCapabilities()).rejects.toThrow("invalid");
  });

  test("accepts bounded provider model identifiers containing dots and slashes", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "b".repeat(64), models: [{
      channelId: "shared-video", channelName: "Videos", protocol: "apimart",
      model: "vendor/doubao-seedance-2.0", kind: "video", modes: ["text_to_video", "image_to_video"],
      durations: [5, 10, 15], maxReferences: 8,
    }] }), { status: 200 })) as typeof fetch;

    const catalog = await listMediaCapabilities();

    expect(catalog.models[0]?.model).toBe("vendor/doubao-seedance-2.0");
    expect(catalog.models[0]?.durations).toEqual([5, 10, 15]);
  });
});
