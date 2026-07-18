import { describe, expect, test } from "bun:test";
import { filenameForMimeType } from "@/lib/download-filename";

describe("filenameForMimeType", () => {
  test("uses media-specific extensions", () => {
    expect(filenameForMimeType("音频", "audio/mpeg", "bin")).toBe("音频.mp3");
    expect(filenameForMimeType("视频", "video/webm", "bin")).toBe("视频.webm");
    expect(filenameForMimeType("图片", "image/jpeg", "bin")).toBe("图片.jpg");
  });

  test("does not duplicate an existing extension", () => {
    expect(filenameForMimeType("library.png", "image/png", "bin")).toBe("library.png");
    expect(filenameForMimeType("clip.MP4", "video/mp4", "bin")).toBe("clip.MP4");
  });

  test("sanitizes path separators and falls back for unknown types", () => {
    expect(filenameForMimeType("../recording", "application/octet-stream", "dat"))
      .toBe(".._recording.dat");
  });
});
