import { describe, expect, test } from "bun:test";
import { prepareImageUpload } from "./image-upload";

describe("prepareImageUpload", () => {
  test("keeps small images byte-for-byte", async () => {
    const original = new Blob([new Uint8Array(1024)], { type: "image/jpeg" });
    expect(await prepareImageUpload(original)).toBe(original);
  });

  test("keeps large JPEG files byte-for-byte instead of transcoding them", async () => {
		const header = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 100, 3]);
    const original = new Blob([header, new Uint8Array(5 * 1024 * 1024)], { type: "image/jpeg" });
    expect(await prepareImageUpload(original)).toBe(original);
  });

	test("preserves PNG and WebP files so animation and exact pixels are not flattened", async () => {
		for (const type of ["image/png", "image/webp"]) {
			const original = new Blob([new Uint8Array(5 * 1024 * 1024)], { type });
			expect(await prepareImageUpload(original)).toBe(original);
		}
	});

	test("rejects oversized JPEG dimensions before bitmap decoding", async () => {
		const header = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xff, 0xff, 0xff, 3]);
		const original = new Blob([header, new Uint8Array(5 * 1024 * 1024)], { type: "image/jpeg" });
		await expect(prepareImageUpload(original)).rejects.toThrow("像素尺寸过大");
	});
});
