const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export function filenameForMimeType(
  name: string,
  mimeType: string | undefined,
  fallbackExtension: string,
): string {
  const safeName = name.trim().replace(/[\\/\u0000-\u001f]/g, "_") || "download";
  const extension = MIME_EXTENSIONS[mimeType?.toLowerCase() ?? ""] ?? fallbackExtension;
  return safeName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ? safeName
    : `${safeName}.${extension}`;
}
