import { describe, expect, test } from "bun:test";
import { resolveProviderCapability } from "@/lib/provider-capabilities";

describe("provider capabilities", () => {
  test("advertises the xAI Grok video generation contract", () => {
    expect(resolveProviderCapability("openai", "video", "grok-imagine-video")).toMatchObject({
      maxImageReferences: 1,
      video: {
        minDuration: 1,
        maxDuration: 15,
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        resolutions: ["480p", "720p"],
        maxImageReferences: 1,
      },
    });
    expect(resolveProviderCapability("openai", "video", "grok-imagine-video-1.5")?.video?.resolutions)
      .toEqual(["480p", "720p", "1080p"]);
  });

  test("resolves exact APIMart Kling families without fuzzy model matching", () => {
    const v26 = resolveProviderCapability("apimart", "video", "kling-v2-6");
    expect(v26?.family).toBe("kling-2.6");
    expect(v26?.video).toMatchObject({
      modes: ["std", "pro"],
      durations: [5, 10],
      maxImageReferences: 2,
      audioModes: ["pro"],
      lastFrameModes: ["pro"],
    });

    const v3 = resolveProviderCapability("apimart", "video", "kling-v3");
    expect(v3?.family).toBe("kling-3");
    expect(v3?.video).toMatchObject({
      modes: ["std", "pro", "4k"],
      minDuration: 3,
      maxDuration: 15,
      maxShots: 6,
      maxElements: 3,
    });

    expect(resolveProviderCapability("apimart", "video", "prefix-kling-v3-suffix")).toBeUndefined();
    expect(resolveProviderCapability("openai", "video", "kling-v3")).toBeUndefined();
  });

  test("returns detached immutable values and fails closed for unknown models", () => {
    const first = resolveProviderCapability("apimart", "video", "kling-v3");
    const second = resolveProviderCapability("apimart", "video", "kling-v3");
    expect(first).not.toBe(second);
    expect(first?.video?.modes).not.toBe(second?.video?.modes);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.video)).toBe(true);
    expect(Object.isFrozen(first?.video?.modes)).toBe(true);
    expect(resolveProviderCapability("apimart", "video", "unknown-paid-model")).toBeUndefined();

    const image = resolveProviderCapability("apimart", "image", "gpt-image-1-official");
    expect(image).toMatchObject({ maxImageReferences: 15, maxOutputs: 4 });
    expect(image?.sizes).toEqual(["1:1", "2:3", "3:2"]);
    expect(Object.isFrozen(image?.sizes)).toBe(true);
    expect(resolveProviderCapability("apimart", "image", "seedream-5-pro")).toBeUndefined();
  });

  test("describes exact APIMart Seedance 2.0 variants", () => {
    const standard = resolveProviderCapability("apimart", "video", "doubao-seedance-2.0");
    expect(standard).toMatchObject({ family: "seedance-2.0", maxImageReferences: 9 });
    expect(standard?.video).toMatchObject({
      minDuration: 4,
      maxDuration: 15,
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
      resolutions: ["480p", "720p", "1080p"],
      maxImageReferences: 9,
    });
    for (const model of ["doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini"]) {
      expect(resolveProviderCapability("apimart", "video", model)?.video?.resolutions).toEqual(["480p", "720p"]);
    }
    expect(resolveProviderCapability("apimart", "video", "seedance-2.0-mini")).toBeUndefined();
  });

  test("describes the current official APIMart image contracts and aliases", () => {
    expect(resolveProviderCapability("apimart", "image", "doubao-seedream-5-0-pro")).toMatchObject({
      family: "seedream-5.0-pro",
      maxImageReferences: 10,
      maxOutputs: 1,
      sizes: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "auto"],
      resolutions: ["1K", "2K"],
    });
    for (const model of ["gemini-3.1-flash-lite-image", "nano-banana-2-lite"]) {
      expect(resolveProviderCapability("apimart", "image", model)).toMatchObject({
        family: "gemini-3.1-flash-lite-image",
        maxImageReferences: 14,
        maxOutputs: 4,
        resolutions: ["1K"],
      });
    }
    expect(resolveProviderCapability("apimart", "image", "nano-banana-2-lite-ext")).toBeUndefined();
    expect(resolveProviderCapability("apimart", "image", "agnes")).toBeUndefined();
  });

  test("describes HappyHorse 1.1 and Kling 3.0 Turbo without Kling v3 assumptions", () => {
    expect(resolveProviderCapability("apimart", "video", "happyhorse-1.1")?.video).toMatchObject({
      modes: ["std"],
      minDuration: 3,
      maxDuration: 15,
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
      resolutions: ["720p", "1080p"],
      maxImageReferences: 9,
      audioModes: [],
      maxShots: 0,
      maxElements: 0,
    });
    expect(resolveProviderCapability("apimart", "video", "kling-3.0-turbo")?.video).toEqual({
      modes: ["std"],
      minDuration: 3,
      maxDuration: 15,
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["720p", "1080p"],
      maxImageReferences: 1,
      audioModes: [],
      lastFrameModes: [],
      maxShots: 0,
      maxElements: 0,
    });
    expect(resolveProviderCapability("apimart", "video", "kling-3.0-turbo-preview")).toBeUndefined();
    expect(resolveProviderCapability("apimart", "video", "agnes")).toBeUndefined();
  });
});
