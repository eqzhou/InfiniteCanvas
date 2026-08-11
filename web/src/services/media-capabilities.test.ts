import { describe, expect, mock, test } from "bun:test";

import { listMediaCapabilities, mediaOptionsForKind } from "./media-capabilities";
import { normalizeAdminMediaCapabilities } from "./admin";

describe("media capability catalog", () => {
  test("loads a versioned safe catalog and derives exact model options", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "a".repeat(64), models: [{ channelId: "shared-image", channelName: "Images", protocol: "openai", model: "gpt-image-1", kind: "image", modes: ["text_to_image", "image_to_image"], sizes: ["1024x1024"], maxReferences: 16 }] }), { status: 200 })) as typeof fetch;
    const catalog = await listMediaCapabilities();
    expect(mediaOptionsForKind(catalog, "image")).toEqual([{ channelId: "shared-image", channelName: "Images", model: "gpt-image-1", protocol: "openai", modes: ["text_to_image", "image_to_image"], sizes: ["1024x1024"], ratios: [], resolutions: [], durations: [], maxReferences: 16 }]);
  });

  test("fails closed for malformed or guessed catalog entries", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "bad", models: [{ channelId: "x", model: "unknown", kind: "image", modes: ["magic"] }] }), { status: 200 })) as typeof fetch;
    await expect(listMediaCapabilities()).rejects.toThrow("invalid");
  });

  test("accepts bounded provider model identifiers containing dots and slashes", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "b".repeat(64), models: [{
      channelId: "shared-video", channelName: "Videos", protocol: "apimart",
      model: "vendor/doubao-seedance-2.0", kind: "video", modes: ["text_to_video", "image_to_video"],
      ratios: ["16:9"], resolutions: ["720p"], durations: [5, 10, 15], maxReferences: 8,
    }] }), { status: 200 })) as typeof fetch;

    const catalog = await listMediaCapabilities();

    expect(catalog.models[0]?.model).toBe("vendor/doubao-seedance-2.0");
    expect(catalog.models[0]?.durations).toEqual([5, 10, 15]);
    expect(catalog.models[0]?.resolutions).toEqual(["720p"]);
  });

  test("accepts catalog sizes expressed as ratios, resolutions, or adaptive mode", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "c".repeat(64), models: [{
      channelId: "shared-video", channelName: "Video", protocol: "apimart", model: "video-main", kind: "video",
      modes: ["text_to_video"], sizes: ["16:9", "720p", "4K", "adaptive"], maxReferences: 0,
    }] }), { status: 200 })) as typeof fetch;
    await expect(listMediaCapabilities()).resolves.toMatchObject({
      models: [{ sizes: ["16:9", "720p", "4K", "adaptive"] }],
    });
  });

  test("normalizes explicit admin capabilities and rejects models outside the channel allow list", () => {
    expect(normalizeAdminMediaCapabilities([{
      model: " gpt-image-1 ", kind: "image", modes: ["image_to_image", "image_to_image", "text_to_image"],
      sizes: ["1024x1024", "1024x1024"], durations: [], maxReferences: 4,
    }], ["gpt-image-1"])).toEqual([{
      model: "gpt-image-1", kind: "image", modes: ["image_to_image", "text_to_image"],
      sizes: ["1024x1024"], durations: [], maxReferences: 4,
    }]);

    expect(() => normalizeAdminMediaCapabilities([{
      model: "unknown", kind: "video", modes: ["text_to_video"], sizes: [], durations: [5], maxReferences: 0,
    }], ["known"])).toThrow(/可用模型/);
  });
});
