import { describe, expect, test } from "bun:test";
import { acceptsWorkbenchReference, mergeReferenceFiles } from "@/lib/reference-files";

describe("reference files", () => {
  test("merges dropped files without losing an existing selection", () => {
    const first = new File(["one"], "first.png", { type: "image/png", lastModified: 1 });
    const duplicate = new File(["one"], "first.png", { type: "image/png", lastModified: 1 });
    const second = new File(["two"], "second.jpg", { type: "image/jpeg", lastModified: 2 });

    expect(mergeReferenceFiles([first], [duplicate, second], 10)).toEqual([first, second]);
  });

  test("keeps a bounded number of accepted references", () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      new File([String(index)], `${index}.png`, { type: "image/png", lastModified: index }));
    expect(mergeReferenceFiles([], files, 9)).toHaveLength(9);
  });

  test("applies the workbench provider file contract to dropped files", () => {
    const png = new File(["png"], "image.png", { type: "image/png" });
    const webp = new File(["webp"], "image.webp", { type: "image/webp" });
    const mp4 = new File(["video"], "clip.mp4", { type: "video/mp4" });
    expect(acceptsWorkbenchReference(png, "image")).toBe(true);
    expect(acceptsWorkbenchReference(webp, "image")).toBe(false);
    expect(acceptsWorkbenchReference(webp, "video", "apimart")).toBe(true);
    expect(acceptsWorkbenchReference(mp4, "video", "openai")).toBe(true);
  });
});
