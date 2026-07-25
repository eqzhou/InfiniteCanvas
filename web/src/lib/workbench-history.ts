import type { AssetItem, GenerationJob } from "@/types/board";

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

export function filterWorkbenchJobs(jobs: readonly GenerationJob[], category: string): GenerationJob[] {
  if (category === WORKBENCH_ALL_CATEGORIES) return [...jobs];
  return jobs.filter((job) => normalizeWorkbenchCategory(job.parameters.category) === category);
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

export function workbenchImageAssets(assets: readonly AssetItem[]): AssetItem[] {
  return assets.filter((asset) =>
    asset.kind === "image" && Boolean(asset.storageKey || asset.coverUrl || asset.content));
}

export function normalizeWorkbenchLayout(value: unknown): WorkbenchLayout {
  return value === "bottom" ? "bottom" : "side";
}
