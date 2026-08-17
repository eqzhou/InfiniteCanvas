import { describe, expect, test } from "bun:test";
import {
  MEDIA_PREVIEW_MAX_EDGE,
  displayCardSrc,
  mediaPreviewKind,
  previewOutputSize,
} from "./media-preview";

describe("media preview sizing", () => {
  test("keeps images already inside the preview box", () => {
    expect(previewOutputSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(previewOutputSize(640, 640)).toEqual({ width: 640, height: 640 });
  });

  test("scales the longest edge to the preview box and never returns zero", () => {
    expect(previewOutputSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(previewOutputSize(1080, 1920)).toEqual({ width: 360, height: 640 });
    expect(previewOutputSize(0, 100)).toEqual({ width: 1, height: 1 });
    expect(previewOutputSize(Number.NaN, 10)).toEqual({ width: 1, height: 1 });
    expect(previewOutputSize(10, -4)).toEqual({ width: 1, height: 1 });
    expect(previewOutputSize(4000, 1000, 200)).toEqual({ width: 200, height: 50 });
  });

  test("exposes the default preview box used by list cards", () => {
    expect(MEDIA_PREVIEW_MAX_EDGE).toBe(640);
  });
});

describe("media preview kind", () => {
  test("classifies by MIME and ignores audio", () => {
    expect(mediaPreviewKind("image/png")).toBe("image");
    expect(mediaPreviewKind("IMAGE/JPEG")).toBe("image");
    expect(mediaPreviewKind("video/mp4")).toBe("video");
    expect(mediaPreviewKind("audio/mpeg")).toBeNull();
    expect(mediaPreviewKind(undefined, "image")).toBe("image");
    expect(mediaPreviewKind("", "video")).toBe("video");
    expect(mediaPreviewKind(undefined, "media")).toBeNull();
    expect(mediaPreviewKind("audio/wav", "video")).toBeNull();
  });
});

describe("list card source selection", () => {
  test("prefers a preview URL and falls back to the original", () => {
    expect(displayCardSrc("blob:thumb", "blob:full")).toBe("blob:thumb");
    expect(displayCardSrc(undefined, "blob:full")).toBe("blob:full");
    expect(displayCardSrc("", "blob:full")).toBe("blob:full");
    expect(displayCardSrc(undefined, undefined)).toBe("");
  });
});
