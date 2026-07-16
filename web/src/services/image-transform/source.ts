import type { BoardNode } from "@/types/board";
import { getBlob, MEDIA_UPLOAD_LIMITS } from "@/services/storage";
import { readBoundedResponse } from "@/services/remote-content";
import { normalizeExternalHttpsUrl } from "@/lib/remote-url";

const IMAGE_MIME_TYPES = ["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"] as const;

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("Failed to decode source image"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fetchImageBlob(content: string, signal?: AbortSignal): Promise<Blob> {
  const url = /^https:/i.test(content) ? normalizeExternalHttpsUrl(content) : content;
  if (!/^(?:https:|blob:|data:)/i.test(url)) throw new Error("Unsupported image source URL");
  const response = await fetch(url, { redirect: "error", signal });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new Error("Image source redirect was rejected");
  }
  if (!response.ok) throw new Error(`Image source HTTP ${response.status}`);
  const remote = await readBoundedResponse(response, {
    maxBytes: MEDIA_UPLOAD_LIMITS.imageBytes,
    mimeTypes: IMAGE_MIME_TYPES,
  });
  return new Blob([remote.bytes], { type: remote.mimeType });
}

export async function resolveNodeImageTransformSource(
  node: BoardNode,
  signal?: AbortSignal,
): Promise<{ blob: Blob; width: number; height: number }> {
  let blob = node.metadata.storageKey
    ? await getBlob("image", node.metadata.storageKey)
    : undefined;
  if (!blob) {
    if (!node.metadata.content) throw new Error("Image node has no source");
    blob = await fetchImageBlob(node.metadata.content, signal);
  }
  const metadataWidth = node.metadata.naturalWidth;
  const metadataHeight = node.metadata.naturalHeight;
  if (Number.isSafeInteger(metadataWidth) && Number.isSafeInteger(metadataHeight) &&
      metadataWidth! > 0 && metadataHeight! > 0) {
    return { blob, width: metadataWidth!, height: metadataHeight! };
  }
  const dimensions = await imageDimensions(blob);
  return { blob, ...dimensions };
}
