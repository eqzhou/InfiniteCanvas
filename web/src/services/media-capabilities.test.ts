import { describe, expect, mock, test } from "bun:test";

import {
  intersectMediaCapabilities,
  listMediaCapabilities,
  mediaOptionsForKind,
  normalizeImageResolutionForCapability,
  resolveMediaCapabilityForRequest,
} from "./media-capabilities";
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

  test("keeps image resolution values in resolutions instead of sizes", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "e".repeat(64), models: [{
      channelId: "shared-image", channelName: "Image", protocol: "apimart", model: "seedream", kind: "image",
      modes: ["text_to_image"], sizes: ["1:1", "1024x1024"], resolutions: ["1K", "2K"], maxReferences: 0,
    }] }), { status: 200 })) as typeof fetch;
    const catalog = await listMediaCapabilities();
    expect(catalog.models[0]?.sizes).toEqual(["1:1", "1024x1024"]);
    expect(catalog.models[0]?.resolutions).toEqual(["1K", "2K"]);

    globalThis.fetch = mock(async () => new Response(JSON.stringify({ version: "f".repeat(64), models: [{
      channelId: "shared-image", channelName: "Image", protocol: "apimart", model: "seedream", kind: "image",
      modes: ["text_to_image"], sizes: ["1K"], maxReferences: 0,
    }] }), { status: 200 })) as typeof fetch;
    await expect(listMediaCapabilities()).rejects.toThrow("invalid");
  });

  test("intersects automatic shared-channel controls so every eligible channel can execute them", () => {
    const base = {
      channelName: "Video", protocol: "openai", model: "video-main", kind: "video" as const,
      sizes: [], modes: ["text_to_video", "image_to_video"] as const,
    };
    const result = intersectMediaCapabilities([
      { ...base, channelId: "a", ratios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], durations: [5, 10], maxReferences: 2 },
      { ...base, channelId: "b", ratios: ["16:9"], resolutions: ["720p"], durations: [5], maxReferences: 1 },
    ]);
    expect(result).toMatchObject({
      channelId: "shared-auto", ratios: ["16:9"], resolutions: ["720p"], durations: [5], maxReferences: 1,
    });
  });

  test("does not expose an image resolution from only one shared channel", () => {
    const base = {
      channelName: "Image", protocol: "apimart", model: "seedream", kind: "image" as const,
      modes: ["text_to_image"] as const, sizes: ["1:1"], ratios: [], durations: [], maxReferences: 0,
    };
    expect(intersectMediaCapabilities([
      { ...base, channelId: "a", resolutions: ["1K", "2K"] },
      { ...base, channelId: "b", resolutions: [] },
    ])).toBeUndefined();
  });

  test("normalizes image resolution only from the declared capability", () => {
    const capability = {
      channelId: "shared-image", channelName: "Images", protocol: "template", model: "custom-image", kind: "image" as const,
      modes: ["text_to_image" as const], sizes: ["1024x1024"], ratios: [], resolutions: ["2K", "4K"], durations: [], maxReferences: 0,
    };
    expect(normalizeImageResolutionForCapability(capability, "4K")).toBe("4K");
    expect(normalizeImageResolutionForCapability(capability, "1K")).toBe("2K");
    expect(normalizeImageResolutionForCapability({ ...capability, resolutions: [] }, "4K")).toBe("");
    expect(normalizeImageResolutionForCapability(undefined, "4K")).toBe("4K");
  });

  test("resolves automatic channel controls only from candidates for the actual generation mode", () => {
    const catalog = { version: "d".repeat(64), models: [
      { channelId: "text", channelName: "Text", protocol: "openai", model: "video-main", kind: "video" as const, modes: ["text_to_video" as const], sizes: [], ratios: ["16:9"], resolutions: ["720p"], durations: [5], maxReferences: 0 },
      { channelId: "image", channelName: "Image", protocol: "openai", model: "video-main", kind: "video" as const, modes: ["image_to_video" as const], sizes: [], ratios: ["9:16"], resolutions: ["1080p"], durations: [10], maxReferences: 1 },
    ] };
    expect(resolveMediaCapabilityForRequest(catalog, "shared-auto", "video", "video-main", "text_to_video"))
      .toMatchObject({ ratios: ["16:9"], durations: [5] });
    expect(resolveMediaCapabilityForRequest(catalog, "shared-auto", "video", "video-main", "image_to_video"))
      .toMatchObject({ ratios: ["9:16"], durations: [10] });
  });

  test("normalizes explicit admin capabilities and rejects models outside the channel allow list", () => {
    expect(normalizeAdminMediaCapabilities([{
      model: " gpt-image-1 ", kind: "image", modes: ["image_to_image", "image_to_image", "text_to_image"],
      sizes: ["1024x1024", "1024x1024"], durations: [], maxReferences: 4,
      resolutions: ["1K", "2K"],
    }], ["gpt-image-1"])).toEqual([{
      model: "gpt-image-1", kind: "image", modes: ["image_to_image", "text_to_image"],
      sizes: ["1024x1024"], durations: [], maxReferences: 4,
      resolutions: ["1K", "2K"],
    }]);

    expect(() => normalizeAdminMediaCapabilities([{
      model: "unknown", kind: "video", modes: ["text_to_video"], sizes: [], durations: [5], maxReferences: 0,
      resolutions: [],
    }], ["known"])).toThrow(/可用模型/);
  });
});
