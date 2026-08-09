import { describe, expect, test } from "bun:test";
import { selectOptimizedImageUpload } from "./image-upload";

describe("selectOptimizedImageUpload", () => {
  test("keeps small images byte-for-byte", async () => {
    const original = new Blob([new Uint8Array(1024)], { type: "image/jpeg" });
    let called = false;
    expect(await selectOptimizedImageUpload(original, async () => {
      called = true;
      return original;
    })).toBe(original);
    expect(called).toBe(false);
  });

  test("uses a materially smaller browser-encoded image", async () => {
		const header = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 100, 3]);
    const original = new Blob([header, new Uint8Array(5 * 1024 * 1024)], { type: "image/jpeg" });
    const optimized = new Blob([new Uint8Array(1024 * 1024)], { type: "image/webp" });
    expect(await selectOptimizedImageUpload(original, async () => optimized)).toBe(optimized);
  });

  test("keeps the original when encoding does not save enough bytes", async () => {
		const header = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 100, 3]);
    const original = new Blob([header, new Uint8Array(5 * 1024 * 1024)], { type: "image/jpeg" });
    const encoded = new Blob([new Uint8Array(4_900_000)], { type: "image/webp" });
    expect(await selectOptimizedImageUpload(original, async () => encoded)).toBe(original);
  });

	test("preserves PNG and WebP files so animation and exact pixels are not flattened", async () => {
		for (const type of ["image/png", "image/webp"]) {
			const original = new Blob([new Uint8Array(5 * 1024 * 1024)], { type });
			let called = false;
			expect(await selectOptimizedImageUpload(original, async () => {
				called = true;
				return original;
			})).toBe(original);
			expect(called).toBe(false);
		}
	});

	test("rejects oversized JPEG dimensions before bitmap decoding", async () => {
		const header = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xff, 0xff, 0xff, 3]);
		const original = new Blob([header, new Uint8Array(5 * 1024 * 1024)], { type: "image/jpeg" });
		await expect(selectOptimizedImageUpload(original, async () => original)).rejects.toThrow("像素尺寸过大");
	});
});
