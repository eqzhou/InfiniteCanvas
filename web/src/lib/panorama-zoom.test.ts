import { describe, expect, test } from "bun:test";
import {
  nextPanoramaFieldOfView,
  nextPanoramaPreviewZoom,
  nextPanoramaViewerZoom,
} from "./panorama-zoom";

describe("panorama wheel zoom", () => {
  test("zooms the node preview in and out without crossing its bounds", () => {
    expect(nextPanoramaPreviewZoom(1, -120)).toBeGreaterThan(1);
    expect(nextPanoramaPreviewZoom(2, 120)).toBeLessThan(2);
    expect(nextPanoramaPreviewZoom(4, -120)).toBe(4);
    expect(nextPanoramaPreviewZoom(1, 120)).toBe(1);
    expect(nextPanoramaPreviewZoom(2, 0)).toBe(2);
  });

  test("uses a narrower camera field of view when the user zooms in", () => {
    expect(nextPanoramaFieldOfView(70, -120)).toBeLessThan(70);
    expect(nextPanoramaFieldOfView(70, 120)).toBeGreaterThan(70);
    expect(nextPanoramaFieldOfView(35, -120)).toBe(35);
    expect(nextPanoramaFieldOfView(100, 120)).toBe(100);
  });

  test("keeps the 2D fallback viewer within its practical zoom range", () => {
    expect(nextPanoramaViewerZoom(1, -120)).toBeGreaterThan(1);
    expect(nextPanoramaViewerZoom(3, -120)).toBe(3);
    expect(nextPanoramaViewerZoom(1, 120)).toBe(1);
  });
});
