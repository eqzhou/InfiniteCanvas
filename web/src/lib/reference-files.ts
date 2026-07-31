export const MAX_REFERENCE_FILES = 10;

export function acceptsWorkbenchReference(
  file: File,
  kind: "image" | "video",
  protocol?: string,
): boolean {
  if (kind === "image") return file.type === "image/png" || file.type === "image/jpeg";
  if (protocol === "apimart") {
    return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type);
  }
  return file.type.startsWith("image/") ||
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/");
}

function referenceFileKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`;
}

export function mergeReferenceFiles(
  current: readonly File[],
  incoming: readonly File[],
  limit = MAX_REFERENCE_FILES,
): File[] {
  const next = new Map<string, File>();
  for (const file of [...current, ...incoming]) {
    if (next.size >= limit) break;
    const key = referenceFileKey(file);
    if (!next.has(key)) next.set(key, file);
  }
  return [...next.values()];
}
