export const MEDIA_PREVIEW_MAX_EDGE = 640;
export const MEDIA_PREVIEW_MIME_TYPE = "image/jpeg";
export const MEDIA_PREVIEW_QUALITY = 0.82;

export function previewOutputSize(
  width: number,
  height: number,
  maxEdge = MEDIA_PREVIEW_MAX_EDGE,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function mediaPreviewKind(
  mimeType?: string,
  fallback?: "image" | "video" | "audio" | "media",
): "image" | "video" | null {
  const mime = (mimeType ?? "").trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return null;
  if (fallback === "image") return "image";
  if (fallback === "video") return "video";
  return null;
}

/** Card/list surfaces should paint the cheap preview when one exists. */
export function displayCardSrc(previewUrl?: string, fullUrl?: string): string {
  return previewUrl?.trim() || fullUrl?.trim() || "";
}

export type MediaPreviewFields = {
  thumbnailStorageKey?: string;
  thumbnailUrl?: string;
};

export function mediaPreviewFields(
  preview?: { thumbnailStorageKey: string; thumbnailUrl: string } | undefined,
): MediaPreviewFields {
  if (!preview?.thumbnailStorageKey) return {};
  return {
    thumbnailStorageKey: preview.thumbnailStorageKey,
    ...(preview.thumbnailUrl ? { thumbnailUrl: preview.thumbnailUrl } : {}),
  };
}
