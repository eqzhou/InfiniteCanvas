import { createStore, del, get, set } from "idb-keyval";
import type { PromptItem, PromptSourceConfig } from "@/types/board";

export type PromptSourceCacheRecord = {
  sourceId: string;
  items: PromptItem[];
  count: number;
  fetchedAt: number;
  lastSuccessAt: string;
  lastError: string;
  signature: string;
};

const cacheStore = createStore("openboard-prompt-cache", "source_cache");
const memory = new Map<string, PromptSourceCacheRecord>();

function cacheKey(sourceId: string): string {
  return `prompt-source:${sourceId}`;
}

export function promptSourceSignature(source: PromptSourceConfig): string {
  const value = [
    source.name,
    source.url,
    source.format,
    source.homepage ?? "",
    JSON.stringify(source.mapping ?? null),
    JSON.stringify(source.html ?? null),
    source.script ?? "",
  ].join("\n");
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return `${value.length}:${hash}`;
}

export async function readPromptSourceCache(
  sourceId: string,
): Promise<PromptSourceCacheRecord | null> {
  const hit = memory.get(sourceId);
  if (hit) return structuredClone(hit);
  try {
    const record = await get<PromptSourceCacheRecord>(cacheKey(sourceId), cacheStore);
    if (!record || typeof record !== "object") return null;
    memory.set(sourceId, record);
    return structuredClone(record);
  } catch {
    return null;
  }
}

export async function writePromptSourceCache(
  record: PromptSourceCacheRecord,
): Promise<void> {
  const next: PromptSourceCacheRecord = {
    sourceId: record.sourceId,
    items: record.items.map((item) => ({
      ...item,
      tags: [...item.tags],
      resultUrls: item.resultUrls ? [...item.resultUrls] : undefined,
    })),
    count: record.count,
    fetchedAt: record.fetchedAt,
    lastSuccessAt: record.lastSuccessAt,
    lastError: record.lastError,
    signature: record.signature,
  };
  memory.set(record.sourceId, next);
  try {
    await set(cacheKey(record.sourceId), next, cacheStore);
  } catch {
    // Cache is best-effort; in-memory still helps the current session.
  }
}

export async function clearPromptSourceCache(sourceId: string): Promise<void> {
  memory.delete(sourceId);
  try {
    await del(cacheKey(sourceId), cacheStore);
  } catch {
    // ignore
  }
}

export function withSourceMeta(
  source: PromptSourceConfig,
  items: readonly PromptItem[],
): PromptItem[] {
  return items.map((item) => ({
    ...item,
    tags: [...item.tags],
    resultUrls: item.resultUrls ? [...item.resultUrls] : undefined,
    source: source.name,
    sourceId: source.id,
  }));
}
