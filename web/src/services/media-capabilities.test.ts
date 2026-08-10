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
});
