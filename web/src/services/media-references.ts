import { storageKeyToDataUrl } from "@/services/storage";

export async function resolveNodeImageDataUrls(storageKeys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const key of storageKeys) {
    const data = await storageKeyToDataUrl(
      key.startsWith("media:") ? "media" : "image",
      key,
    );
    if (data) out.push(data);
  }
  return out;
}

export async function resolveNodeImageDataUrl(
  storageKey: string | undefined,
  fallbackContent: string | undefined,
): Promise<string | null> {
  if (storageKey) {
    const [stored] = await resolveNodeImageDataUrls([storageKey]);
    if (stored) return stored;
  }
  return fallbackContent?.startsWith("data:image/") ? fallbackContent : null;
}

export async function resolveMediaRefs(
  items: Array<{ storageKey?: string; content?: string }>,
  limit: number,
): Promise<string[]> {
  const out: string[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    if (item.content && /^https?:\/\//i.test(item.content)) {
      out.push(item.content);
      continue;
    }
    if (item.storageKey) {
      const kind = item.storageKey.startsWith("media:") ? "media" : "image";
      try {
        const data = await storageKeyToDataUrl(kind, item.storageKey);
        if (data) {
          out.push(data);
          continue;
        }
      } catch {
        // A live inline URL may still be usable while local storage is unavailable.
      }
    }
    if (item.content?.startsWith("data:") || item.content?.startsWith("blob:")) {
      if (item.content.startsWith("blob:")) {
        try {
          out.push(await blobToDataUrl(await (await fetch(item.content)).blob()));
        } catch {
          // Ignore a stale browser object URL.
        }
      } else {
        out.push(item.content);
      }
    }
  }
  return out;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
