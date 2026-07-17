import { describe, expect, test } from "bun:test";
import { resolveVideoDuration, validateArkVideoRequest } from "./video-generation";

describe("video generation parameters", () => {
  test("omits duration for smart timing", () => {
    expect(resolveVideoDuration(true, 8)).toBeUndefined();
    expect(resolveVideoDuration(false, 8)).toBe(8);
  });

  test("enforces the documented Ark duration and fast-model resolution limits", () => {
    expect(() => validateArkVideoRequest("seedance-fast", "1080p", 5)).toThrow("1080p");
    expect(() => validateArkVideoRequest("seedance-pro", "720p", 3)).toThrow("4-15");
    expect(() => validateArkVideoRequest("seedance-pro", "1080p", undefined)).not.toThrow();
    expect(() => validateArkVideoRequest("seedance-fast", "720p", 15)).not.toThrow();
  });
});
