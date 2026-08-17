import {
  MEDIA_PREVIEW_MAX_EDGE,
  MEDIA_PREVIEW_MIME_TYPE,
  MEDIA_PREVIEW_QUALITY,
  mediaPreviewKind,
  previewOutputSize,
} from "@/lib/media-preview";
import { getBlob, uploadMedia } from "@/services/storage";

export type MediaPreview = {
  thumbnailStorageKey: string;
  thumbnailUrl: string;
};

export type MediaPreviewEncoder = (
  source: Blob,
  kind: "image" | "video",
) => Promise<Blob>;

type ImageLike = CanvasImageSource & { width: number; height: number; close?: () => void };

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode preview"))),
      type,
      quality,
    );
  });
}

async function decodeImage(blob: Blob): Promise<ImageLike> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // HTMLImageElement accepts a few browser-decodable images rejected by createImageBitmap.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to decode image"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encodeImagePreview(source: Blob, maxEdge: number): Promise<Blob> {
  const image = await decodeImage(source);
  try {
    if (!image.width || !image.height) throw new Error("Image has no displayable pixels");
    const { width, height } = previewOutputSize(image.width, image.height, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("Canvas unavailable");
    drawing.imageSmoothingEnabled = true;
    drawing.imageSmoothingQuality = "high";
    drawing.drawImage(image, 0, 0, width, height);
    return await canvasToBlob(canvas, MEDIA_PREVIEW_MIME_TYPE, MEDIA_PREVIEW_QUALITY);
  } finally {
    image.close?.();
  }
}

async function encodeVideoPoster(source: Blob, maxEdge: number): Promise<Blob> {
  const url = URL.createObjectURL(source);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Timed out reading video")), 8_000);
      video.onloadeddata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Failed to decode video"));
      };
    });
    try {
      video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration / 4 : 0.1);
    } catch {
      // Some containers reject seeking before a frame is available.
    }
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => resolve(), 1_000);
      video.onseeked = () => {
        window.clearTimeout(timeout);
        resolve();
      };
    });
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("Video has no displayable frame");
    }
    const { width, height } = previewOutputSize(video.videoWidth, video.videoHeight, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("Canvas unavailable");
    drawing.drawImage(video, 0, 0, width, height);
    return await canvasToBlob(canvas, MEDIA_PREVIEW_MIME_TYPE, MEDIA_PREVIEW_QUALITY);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function createMediaPreviewBlob(
  source: Blob,
  kind: "image" | "video",
  maxEdge = MEDIA_PREVIEW_MAX_EDGE,
): Promise<Blob> {
  return kind === "video" ? encodeVideoPoster(source, maxEdge) : encodeImagePreview(source, maxEdge);
}

export async function storeMediaPreview(
  source: Blob,
  kind: "image" | "video",
  options: {
    signal?: AbortSignal;
    encode?: MediaPreviewEncoder;
  } = {},
): Promise<MediaPreview | undefined> {
  try {
    const encode = options.encode ?? createMediaPreviewBlob;
    const blob = await encode(source, kind);
    if (!blob.size) return undefined;
    const stored = await uploadMedia(blob, "image", { signal: options.signal });
    return {
      thumbnailStorageKey: stored.storageKey,
      thumbnailUrl: stored.url,
    };
  } catch {
    return undefined;
  }
}

export async function attachPreviewToStoredMedia(
  storageKey: string,
  mimeType?: string,
  options: {
    signal?: AbortSignal;
    encode?: MediaPreviewEncoder;
  } = {},
): Promise<MediaPreview | undefined> {
  try {
    const kind = mediaPreviewKind(mimeType, storageKey.startsWith("media:") ? "media" : "image");
    if (!kind) return undefined;
    const blob = await getBlob(storageKey.startsWith("media:") ? "media" : "image", storageKey);
    if (!blob) return undefined;
    return storeMediaPreview(blob, kind, options);
  } catch {
    return undefined;
  }
}

export function displayMediaNodeFields(uploaded: UploadedDisplayMedia) {
  return {
    content: uploaded.url,
    storageKey: uploaded.storageKey,
    thumbnailStorageKey: uploaded.thumbnailStorageKey,
    thumbnailUrl: uploaded.thumbnailUrl,
    naturalWidth: uploaded.width,
    naturalHeight: uploaded.height,
    bytes: uploaded.bytes,
    mimeType: uploaded.mimeType,
  };
}

export type UploadedDisplayMedia = Awaited<ReturnType<typeof uploadMedia>> & MediaPreviewFields;

type MediaPreviewFields = {
  thumbnailStorageKey?: string;
  thumbnailUrl?: string;
};

export async function uploadDisplayMedia(
  input: Blob | string,
  kind: "image" | "media" = "image",
  options: Parameters<typeof uploadMedia>[2] & {
    encodePreview?: MediaPreviewEncoder;
    previewKind?: "image" | "video";
  } = {},
): Promise<UploadedDisplayMedia> {
  const { encodePreview, previewKind, ...uploadOptions } = options;
  const uploaded = await uploadMedia(input, kind, uploadOptions);
  const resolvedKind = previewKind ?? mediaPreviewKind(uploaded.mimeType, kind === "image" ? "image" : "media");
  if (!resolvedKind) return uploaded;
  const preview = await storeMediaPreview(uploaded.blob, resolvedKind, {
    signal: uploadOptions.signal,
    encode: encodePreview,
  });
  return preview ? { ...uploaded, ...preview } : uploaded;
}

export async function enrichResultItemsWithPreviews<T extends {
  storageKey?: string;
  mimeType?: string;
  thumbnailStorageKey?: string;
  thumbnailUrl?: string;
}>(
  items: readonly T[],
  options: { signal?: AbortSignal; encode?: MediaPreviewEncoder } = {},
): Promise<T[]> {
  return Promise.all(items.map(async (item) => {
    if (!item.storageKey || item.thumbnailStorageKey) return item;
    try {
      const preview = await attachPreviewToStoredMedia(item.storageKey, item.mimeType, options);
      return preview ? { ...item, ...preview } : item;
    } catch {
      return item;
    }
  }));
}
