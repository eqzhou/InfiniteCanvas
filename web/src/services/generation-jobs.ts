import { clear, createStore, del, entries, get, set, setMany } from "idb-keyval";
import type {
  GenerationJob,
  GenerationJobPage,
  GenerationKind,
  GenerationStatus,
} from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { validateJsonObject } from "@/lib/bounded-json";

const SERVER_STORAGE = import.meta.env.VITE_OPENBOARD_STORAGE === "server";
const jobStore = createStore("openboard-generation-jobs", "jobs");
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type GenerationJobQuery = {
  projectId?: string;
  kind?: GenerationKind;
  page?: number;
  pageSize?: number;
};

export type NewGenerationJob = Omit<GenerationJob, "id" | "createdAt" | "updatedAt"> & { id?: string };

function validatePagination(page: number, pageSize: number): void {
  if (!Number.isInteger(page) || page < 1) throw new Error("page must be a positive integer");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("pageSize must be between 1 and 100");
  }
}

export function paginateGenerationJobs(
  jobs: GenerationJob[],
  query: GenerationJobQuery,
): GenerationJobPage {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  validatePagination(page, pageSize);
  const filtered = jobs
    .filter((job) => !query.projectId || job.projectId === query.projectId)
    .filter((job) => !query.kind || job.kind === query.kind)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    page,
    pageSize,
    total: filtered.length,
  };
}

export function validateGenerationJob(job: GenerationJob): GenerationJob {
  const kinds = new Set<GenerationKind>(["image", "video"]);
  const statuses = new Set<GenerationStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);
  if (!ID.test(job.id) || (job.projectId && !ID.test(job.projectId)) || !kinds.has(job.kind) ||
    !statuses.has(job.status) || job.prompt.length > 100_000 || (job.providerId?.length ?? 0) > 500 ||
    (job.model?.length ?? 0) > 500 || (job.error?.length ?? 0) > 10_000 ||
    Number.isNaN(Date.parse(job.createdAt)) || Number.isNaN(Date.parse(job.updatedAt))) {
    throw new Error("invalid generation job");
  }
  validateJsonObject(job.parameters, { label: "generation parameters", maxBytes: 256 * 1024, maxDepth: 20, maxEntries: 20_000 });
  validateJsonObject(job.result, { label: "generation result", maxBytes: 512 * 1024, maxDepth: 20, maxEntries: 20_000 });
  return structuredClone(job);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path.replace(/^\/+/, "")}`, {
    ...init,
    credentials: "same-origin",
    redirect: "error",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) throw new Error(`Generation history failed: HTTP ${response.status}`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listGenerationJobs(query: GenerationJobQuery = {}): Promise<GenerationJobPage> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  validatePagination(page, pageSize);
  if (SERVER_STORAGE) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (query.projectId) params.set("projectId", query.projectId);
    if (query.kind) params.set("kind", query.kind);
    const result = await api<GenerationJobPage>(`generation-jobs?${params}`);
    return { ...result, items: result.items.map(validateGenerationJob) };
  }
  const values = (await entries<string, GenerationJob>(jobStore)).map(([, value]) => validateGenerationJob(value));
  return paginateGenerationJobs(values, query);
}

export async function getGenerationJob(id: string): Promise<GenerationJob | undefined> {
  if (!ID.test(id)) throw new Error("invalid generation job id");
  if (SERVER_STORAGE) {
    try {
      return validateGenerationJob(await api<GenerationJob>(`generation-jobs/${encodeURIComponent(id)}`));
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("HTTP 404")) return undefined;
      throw error;
    }
  }
  const value = await get<GenerationJob>(id, jobStore);
  return value ? validateGenerationJob(value) : undefined;
}

export async function createGenerationJob(input: NewGenerationJob): Promise<GenerationJob> {
  const timestamp = nowIso();
  const job = validateGenerationJob({ ...input, id: input.id ?? uid("job"), createdAt: timestamp, updatedAt: timestamp });
  if (SERVER_STORAGE) {
    return validateGenerationJob(await api<GenerationJob>("generation-jobs", { method: "POST", body: JSON.stringify(job) }));
  }
  if (await get(job.id, jobStore)) throw new Error("generation job already exists");
  await set(job.id, job, jobStore);
  return job;
}

export async function updateGenerationJob(id: string, patch: Partial<GenerationJob>): Promise<GenerationJob> {
  const current = await getGenerationJob(id);
  if (!current) throw new Error("generation job not found");
  const job = validateGenerationJob({ ...current, ...patch, id, createdAt: current.createdAt, updatedAt: nowIso() });
  if (SERVER_STORAGE) {
    return validateGenerationJob(await api<GenerationJob>(`generation-jobs/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(job) }));
  }
  await set(id, job, jobStore);
  return job;
}

export async function deleteGenerationJob(id: string): Promise<void> {
  if (!ID.test(id)) throw new Error("invalid generation job id");
  if (SERVER_STORAGE) {
    await api<void>(`generation-jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    return;
  }
  await del(id, jobStore);
}

export async function listAllGenerationJobs(): Promise<GenerationJob[]> {
  const jobs: GenerationJob[] = [];
  let page = 1;
  while (true) {
    const result = await listGenerationJobs({ page, pageSize: 100 });
    jobs.push(...result.items);
    if (page * result.pageSize >= result.total) return jobs;
    page += 1;
  }
}

export async function replaceGenerationJobs(jobs: GenerationJob[]): Promise<void> {
  if (jobs.length > 10_000) throw new Error("generation history exceeds 10000 items");
  const validated = jobs.map(validateGenerationJob);
  const ids = new Set<string>();
  for (const job of validated) {
    if (ids.has(job.id)) throw new Error("duplicate generation job id");
    ids.add(job.id);
  }
  if (SERVER_STORAGE) {
    await api<void>("generation-jobs", { method: "PUT", body: JSON.stringify(validated) });
    return;
  }
  await clear(jobStore);
  await setMany(validated.map((job) => [job.id, job] as [IDBValidKey, GenerationJob]), jobStore);
}

export async function collectGenerationStorageKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const job of await listAllGenerationJobs()) {
      const references = Array.isArray(job.parameters.referenceStorageKeys)
        ? job.parameters.referenceStorageKeys
        : [];
      for (const key of references) if (typeof key === "string") keys.add(key);
      const items = Array.isArray(job.result.items) ? job.result.items : [];
      for (const item of items) {
        if (item && typeof item === "object" && typeof (item as { storageKey?: unknown }).storageKey === "string") {
          keys.add((item as { storageKey: string }).storageKey);
        }
      }
  }
  return keys;
}
