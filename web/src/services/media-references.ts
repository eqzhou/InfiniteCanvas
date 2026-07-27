import { authFetch } from "@/services/auth-session";
import { storageKeyToDataUrl } from "@/services/storage";

const MAX_MEDIA_REFERENCE_KEYS = 20;

function serverStorageEnabled(): boolean {
  return import.meta.env.VITE_OPENBOARD_STORAGE === "server";
}

export type MediaReferenceItem = {
  token: string;
  tenantId?: string;
  storageKey: string;
  expiresAt: string;
};

export type CreateMediaReferencesResult = {
  items: MediaReferenceItem[];
  expiresAt: string;
};

/**
 * Build a provider-facing absolute URL for a short-lived reference token.
 * Providers that fetch media themselves need a reachable HTTPS origin; loopback
 * and plain HTTP are left as-is for local debugging and fail closed upstream.
 */
export function mediaReferencePublicUrl(token: string, origin = typeof window !== "undefined" ? window.location.origin : ""): string {
  const clean = token.trim();
  if (!clean) return "";
  const base = origin.replace(/\/+$/, "");
  if (!base) return `/api/media/references/${encodeURIComponent(clean)}`;
  return `${base}/api/media/references/${encodeURIComponent(clean)}`;
}

/** True when the browser origin is a plausible third-party-fetchable HTTPS URL. */
export function canMintPublicMediaReferences(origin = typeof window !== "undefined" ? window.location.origin : ""): boolean {
  if (!serverStorageEnabled() || !origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Mint short-lived tokens for tenant blobs so upstream providers can fetch them
 * without receiving data: URLs. Requires an authenticated session when auth is on.
 */
export async function createMediaReferences(
  storageKeys: readonly string[],
  ttlSeconds = 900,
): Promise<CreateMediaReferencesResult> {
  const keys = Array.from(new Set(storageKeys.map((key) => key.trim()).filter(Boolean)));
  if (!keys.length) throw new Error("storageKeys must contain 1-20 keys");
  if (keys.length > MAX_MEDIA_REFERENCE_KEYS) throw new Error("storageKeys must contain 1-20 keys");
  const ttl = Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0
    ? Math.max(60, Math.min(86_400, ttlSeconds))
    : 900;
  const response = await authFetch("media/references", {
    method: "POST",
    body: JSON.stringify({ storageKeys: keys, ttlSeconds: ttl }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Media reference mint failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    items?: unknown;
    expiresAt?: unknown;
  };
  if (!Array.isArray(payload.items) || typeof payload.expiresAt !== "string") {
    throw new Error("Media reference response is malformed");
  }
  const items: MediaReferenceItem[] = [];
  for (const raw of payload.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Media reference response is malformed");
    }
    const item = raw as Partial<MediaReferenceItem>;
    if (typeof item.token !== "string" || !item.token.trim()) {
      throw new Error("Media reference response is malformed");
    }
    if (typeof item.storageKey !== "string" || !item.storageKey.trim()) {
      throw new Error("Media reference response is malformed");
    }
    items.push({
      token: item.token,
      storageKey: item.storageKey,
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : payload.expiresAt,
      ...(typeof item.tenantId === "string" ? { tenantId: item.tenantId } : {}),
    });
  }
  return { items, expiresAt: payload.expiresAt };
}

/**
 * Resolve storage keys to public HTTPS URLs when possible. Keys that cannot be
 * minted are omitted so the caller can fall back to data URLs.
 */
export async function resolvePublicMediaReferenceUrls(
  storageKeys: readonly string[],
  ttlSeconds = 900,
): Promise<Map<string, string>> {
  const keys = Array.from(new Set(storageKeys.map((key) => key.trim()).filter(Boolean)));
  const out = new Map<string, string>();
  if (!keys.length || !canMintPublicMediaReferences()) return out;
  try {
    const minted = await createMediaReferences(keys, ttlSeconds);
    for (const item of minted.items) {
      const url = mediaReferencePublicUrl(item.token);
      if (url) out.set(item.storageKey, url);
    }
  } catch {
    // Fall through to data/blob URLs; the provider path will surface a clearer error.
  }
  return out;
}

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
  options?: { preferPublicUrls?: boolean },
): Promise<string[]> {
  const preferPublic = options?.preferPublicUrls !== false;
  const publicUrls = preferPublic
    ? await resolvePublicMediaReferenceUrls(
      items.map((item) => item.storageKey).filter((key): key is string => Boolean(key)),
    )
    : new Map<string, string>();

  const out: string[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    if (item.content && /^https?:\/\//i.test(item.content)) {
      out.push(item.content);
      continue;
    }
    if (item.storageKey && publicUrls.has(item.storageKey)) {
      out.push(publicUrls.get(item.storageKey)!);
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
