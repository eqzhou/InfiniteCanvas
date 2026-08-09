const IMAGE_OPTIMIZE_THRESHOLD_BYTES = 4 * 1024 * 1024;
const IMAGE_OPTIMIZE_MAX_EDGE = 4096;
const IMAGE_OPTIMIZE_MAX_PIXELS = 100_000_000;
const IMAGE_OPTIMIZE_MIN_SAVING = 0.1;

type ImageTranscoder = (source: Blob) => Promise<Blob>;

async function readJpegDimensions(source: Blob): Promise<{ width: number; height: number } | null> {
	const bytes = new Uint8Array(await source.slice(0, Math.min(source.size, 1 << 20)).arrayBuffer());
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 8 < bytes.length) {
		if (bytes[offset] !== 0xff) { offset += 1; continue; }
		const marker = bytes[offset + 1]!;
		if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
		const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
		if (length < 2 || offset + 2 + length > bytes.length) return null;
		if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
			return {
				height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
				width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
			};
		}
		offset += 2 + length;
	}
	return null;
}

async function browserTranscodeImage(source: Blob): Promise<Blob> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return source;
  const bitmap = await createImageBitmap(source);
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > IMAGE_OPTIMIZE_MAX_PIXELS) {
      return source;
    }
    const scale = Math.min(1, IMAGE_OPTIMIZE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return source;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((encoded) => resolve(encoded ?? source), "image/webp", 0.88);
    });
  } finally {
    bitmap.close();
  }
}

export async function selectOptimizedImageUpload(
  source: Blob,
  transcode: ImageTranscoder = browserTranscodeImage,
): Promise<Blob> {
	if (source.size <= IMAGE_OPTIMIZE_THRESHOLD_BYTES || source.type !== "image/jpeg") return source;
	const dimensions = await readJpegDimensions(source);
	if (!dimensions) return source;
	if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > IMAGE_OPTIMIZE_MAX_PIXELS) {
		throw new Error("图片像素尺寸过大，无法安全上传");
	}
  try {
    const encoded = await transcode(source);
    return encoded.size <= source.size * (1 - IMAGE_OPTIMIZE_MIN_SAVING) ? encoded : source;
  } catch {
    return source;
  }
}
