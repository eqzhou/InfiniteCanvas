import { authFetch } from "@/services/auth-session";
import type { PromptItem } from "@/types/board";

export const PUBLIC_PROMPT_CATALOG_SOURCE_ID = "server-public-prompt-catalog";
const CACHE_PREFIX = "openboard:public-prompt-catalog:v1:";

export type PublicPromptCatalog = {
  version: 1;
  revision: number;
  categories: Array<{ id: string; name: string; order: number }>;
  prompts: Array<{ id: string; categoryId?: string; title: string; body: string; tags: string[]; updatedAt?: string }>;
};

type CatalogCache = { etag: string; catalog: PublicPromptCatalog };
type CatalogFetch = (path: string, init?: RequestInit) => Promise<Response>;
const volatileCache = new Map<string, CatalogCache>();

const emptyCatalog = (): PublicPromptCatalog => ({ version: 1, revision: 0, categories: [], prompts: [] });

function cacheKey(scope: string): string {
  return `${CACHE_PREFIX}${encodeURIComponent(scope || "open")}`;
}

function parseCatalog(value: unknown): PublicPromptCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("提示词库响应无效");
  const input = value as Partial<PublicPromptCatalog>;
  if (input.version !== 1 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 ||
      !Array.isArray(input.categories) || !Array.isArray(input.prompts) || input.prompts.length > 20_000) {
    throw new Error("提示词库响应无效");
  }
  const prompts = input.prompts.map((item) => {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.title !== "string" || !item.title ||
        typeof item.body !== "string" || !item.body || !Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === "string")) {
      throw new Error("提示词库响应无效");
    }
    return { ...item, tags: [...item.tags] };
  });
  return { version: 1, revision: Number(input.revision), categories: [...input.categories], prompts };
}

function readCache(scope: string): CatalogCache | null {
  const key = cacheKey(scope);
  try {
    if (typeof sessionStorage === "undefined") return volatileCache.get(key) ?? null;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CatalogCache>;
    if (typeof parsed.etag !== "string") return null;
    return { etag: parsed.etag, catalog: parseCatalog(parsed.catalog) };
  } catch {
    return null;
  }
}

function writeCache(scope: string, value: CatalogCache): void {
  const key = cacheKey(scope);
  volatileCache.set(key, value);
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A valid network result remains usable when browser storage is unavailable.
  }
}

export async function loadPublicPromptCatalog(
  scope: string,
  fetcher: CatalogFetch = authFetch,
): Promise<{ catalog: PublicPromptCatalog; stale: boolean; error?: string }> {
  const cached = readCache(scope);
  try {
    const headers = new Headers();
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    const response = await fetcher("prompt-catalog", { headers });
    if (response.status === 304 && cached) return { catalog: cached.catalog, stale: false };
    if (!response.ok) throw new Error(`提示词库请求失败（HTTP ${response.status}）`);
    const catalog = parseCatalog(await response.json());
    const etag = response.headers.get("ETag") || `"prompt-catalog-${catalog.revision}"`;
    writeCache(scope, { etag, catalog });
    return { catalog, stale: false };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return { catalog: cached?.catalog ?? emptyCatalog(), stale: true, error };
  }
}

export function mergePublicPromptCatalog(
  prompts: readonly PromptItem[],
  catalog: PublicPromptCatalog,
): PromptItem[] {
  const personal = prompts.filter((item) => item.sourceId !== PUBLIC_PROMPT_CATALOG_SOURCE_ID);
  const shared = catalog.prompts.map((item) => ({
    id: `catalog:${item.id}`,
    title: item.title,
    body: item.body,
    tags: [...item.tags],
    source: "团队提示词库",
    sourceId: PUBLIC_PROMPT_CATALOG_SOURCE_ID,
  }));
  return [...personal, ...shared];
}

export function stripPublicPromptCatalog(prompts: readonly PromptItem[]): PromptItem[] {
  return prompts.filter((item) => item.sourceId !== PUBLIC_PROMPT_CATALOG_SOURCE_ID);
}
