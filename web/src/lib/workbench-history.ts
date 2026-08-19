import type { AssetItem, GenerationJob } from "@/types/board";
import { workbenchImageCountFromParameters } from "@/lib/image-generation-batch";

export type WorkbenchLayout = "side" | "bottom";

export const WORKBENCH_ALL_CATEGORIES = "全部";
export const WORKBENCH_UNCATEGORIZED = "未分类";

export function normalizeWorkbenchCategory(value: unknown): string {
  if (typeof value !== "string") return WORKBENCH_UNCATEGORIZED;
  const normalized = value.trim();
  return normalized && normalized.length <= 100 ? normalized : WORKBENCH_UNCATEGORIZED;
}

export function workbenchCategories(jobs: readonly GenerationJob[]): string[] {
  const categories: string[] = [];
  let uncategorized = false;
  for (const job of jobs) {
    const category = normalizeWorkbenchCategory(job.parameters.category);
    if (category === WORKBENCH_UNCATEGORIZED) {
      uncategorized = true;
    } else if (!categories.includes(category)) {
      categories.push(category);
    }
  }
  return [WORKBENCH_ALL_CATEGORIES, ...categories, ...(uncategorized ? [WORKBENCH_UNCATEGORIZED] : [])];
}

export type WorkbenchStatusFilter = "all" | "succeeded" | "failed" | string;

export function filterWorkbenchJobs(
  jobs: readonly GenerationJob[],
  category: string,
  status: WorkbenchStatusFilter = "succeeded",
): GenerationJob[] {
  return jobs.filter((job) => {
    if (category !== WORKBENCH_ALL_CATEGORIES && normalizeWorkbenchCategory(job.parameters.category) !== category) {
      return false;
    }
    if (status === "all" || status === "") return true;
    if (status === "succeeded") {
      return job.status === "succeeded" || job.status === "running" || job.status === "queued";
    }
    if (status === "failed") {
      return job.status === "failed" || job.status === "cancelled";
    }
    return job.status === status;
  });
}

export function formatWorkbenchBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${formatUnit(value / 1024)} KB`;
  return `${formatUnit(value / (1024 * 1024))} MB`;
}

function formatUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

export function workbenchReferenceKeys(job: GenerationJob): string[] {
  const values = Array.isArray(job.parameters.referenceStorageKeys) ? job.parameters.referenceStorageKeys : [];
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 512)
    .slice(0, 16);
}

/** The subset of the generation form a history record can restore. */
export type WorkbenchRefillForm = {
  prompt: string;
  model: string;
  providerId: string;
  size: string;
  quality: string;
  count: number;
  transparentBackground: boolean;
  category: string;
  referenceStorageKeys: string[];
};

function refillText(raw: unknown, current: string): string {
  if (typeof raw !== "string") return current;
  const trimmed = raw.trim();
  return trimmed ? trimmed : current;
}

/**
 * Restores a past generation record into the form.
 *
 * Upstream lists refill separately from retry: retry re-runs a record exactly
 * as it was, while refill puts its settings back on the form so they can be
 * adjusted before generating again. A record is persisted data, so every field
 * is validated here; anything missing or unusable keeps the value the form
 * already has rather than blanking it. Neither input is mutated.
 */
export function workbenchRefillForm(
  job: GenerationJob,
  current: WorkbenchRefillForm,
): WorkbenchRefillForm {
  const parameters = job.parameters ?? {};
  const count = parameters.count;
  const transparent = parameters.transparentBackground;
  const category = parameters.category;
  const references = workbenchReferenceKeys(job);
  return {
    prompt: refillText(job.prompt, current.prompt),
    model: refillText(job.model, current.model),
    providerId: refillText(job.providerId, current.providerId),
    size: refillText(parameters.size, current.size),
    quality: refillText(parameters.quality, current.quality),
    count: typeof parameters.requestedCount === "number" || typeof count === "number"
      ? workbenchImageCountFromParameters(parameters as Record<string, unknown>, current.count)
      : current.count,
    transparentBackground: transparent === undefined ? current.transparentBackground : transparent === true,
    category: category === undefined ? current.category : normalizeWorkbenchCategory(category),
    // An empty reference list is indistinguishable from "not recorded", so it
    // falls back rather than silently dropping the references already picked.
    referenceStorageKeys: references.length ? references : [...current.referenceStorageKeys],
  };
}

/**
 * Maps the storage keys a record kept back onto selectable library assets.
 *
 * A reference uploaded straight from disk has no asset behind it, so the form
 * cannot re-select it. Those are counted rather than dropped silently, so the
 * caller can tell the user which references need picking again.
 */
export function workbenchRefillAssetIds(
  storageKeys: readonly string[],
  assets: readonly AssetItem[],
): { assetIds: string[]; unresolved: number } {
  const byStorageKey = new Map<string, string>();
  for (const asset of workbenchImageAssets(assets)) {
    if (asset.storageKey && !byStorageKey.has(asset.storageKey)) byStorageKey.set(asset.storageKey, asset.id);
  }
  const assetIds: string[] = [];
  let unresolved = 0;
  for (const key of storageKeys) {
    const assetId = byStorageKey.get(key);
    if (!assetId) {
      unresolved += 1;
    } else if (!assetIds.includes(assetId)) {
      assetIds.push(assetId);
    }
  }
  return { assetIds, unresolved };
}

export function workbenchCardMedia(item: {
  url?: string;
  thumbnailUrl?: string;
  storageKey?: string;
  thumbnailStorageKey?: string;
}): {
  cardUrl: string;
  fullUrl: string;
  hasPreview: boolean;
  cardKey?: string;
  fullKey?: string;
} {
  const hasPreview = Boolean(item.thumbnailStorageKey?.trim() || item.thumbnailUrl?.trim());
  return {
    cardUrl: hasPreview ? (item.thumbnailUrl?.trim() || "") : "",
    fullUrl: item.url?.trim() || "",
    hasPreview,
    cardKey: item.thumbnailStorageKey?.trim() || undefined,
    fullKey: item.storageKey?.trim() || undefined,
  };
}

export function workbenchImageAssets(assets: readonly AssetItem[]): AssetItem[] {
  return assets.filter((asset) =>
    asset.kind === "image" && Boolean(asset.storageKey || asset.coverUrl || asset.content));
}

export function normalizeWorkbenchLayout(value: unknown): WorkbenchLayout {
  return value === "bottom" ? "bottom" : "side";
}

/**
 * Keep history card order stable while jobs stream in.
 * Matching ids are updated in place. Brand-new ids are inserted after the
 * last already-visible incoming job so a batch grows left-to-right.
 */
export function upsertWorkbenchJobs(
  current: readonly GenerationJob[],
  incoming: readonly GenerationJob[],
): GenerationJob[] {
  if (incoming.length === 0) return [...current];
  const incomingById = new Map(incoming.map((job) => [job.id, job]));
  const currentIds = new Set(current.map((job) => job.id));
  const updated = current.map((job) => incomingById.get(job.id) ?? job);
  const added = incoming.filter((job) => !currentIds.has(job.id));
  if (added.length === 0) return updated;
  let insertAt = 0;
  for (let index = 0; index < updated.length; index += 1) {
    if (incomingById.has(updated[index]!.id)) insertAt = index + 1;
  }
  return [...updated.slice(0, insertAt), ...added, ...updated.slice(insertAt)];
}
