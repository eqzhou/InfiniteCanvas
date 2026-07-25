import {
  arkImageReferenceRoles,
  normalizeVideoFrameMode,
  resolveVideoDuration,
  validateArkVideoRequest,
} from "./video-generation";

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

  test("maps ordered image references into first/last frame roles", () => {
    expect(normalizeVideoFrameMode("first-last")).toBe("first-last");
    expect(normalizeVideoFrameMode("references")).toBe("references");
    expect(normalizeVideoFrameMode(undefined)).toBe("references");
    expect(arkImageReferenceRoles("references", 3)).toEqual([
      "reference_image",
      "reference_image",
      "reference_image",
    ]);
    expect(arkImageReferenceRoles("first-last", 1)).toEqual(["first_frame"]);
    expect(arkImageReferenceRoles("first-last", 3)).toEqual([
      "first_frame",
      "last_frame",
      "reference_image",
    ]);
  });
});
