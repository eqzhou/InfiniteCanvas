import type {
  GenerationJob,
  GenerationJobPage,
  GenerationKind,
  GenerationStatus,
} from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { validateJsonObject } from "@/lib/bounded-json";
import { authFetch } from "@/services/auth-session";
import { collectWorkflowJobStorageKeys, validateWorkflowGenerationJob } from "@/lib/workflow-job";
import {
  normalizeWorkbenchCategory,
  WORKBENCH_ALL_CATEGORIES,
  workbenchCategories,
} from "@/lib/workbench-history";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const LEGACY_GENERATION_GRACE_MS = 30 * 60_000;

export type GenerationJobQuery = {
  projectId?: string;
  kind?: GenerationKind;
  status?: string;
  category?: string;
  page?: number;
  pageSize?: number;
  /** When true, include soft-deleted tombstones (ownership/cleanup only). */
  includeDeleted?: boolean;
};

export type NewGenerationJob = Omit<GenerationJob, "id" | "createdAt" | "updatedAt"> & { id?: string };

export type ServerImageGenerationInput = {
	id?: string;
	projectId?: string;
	prompt: string;
	providerId: string;
	model?: string;
	parameters: {
		size: string;
		quality?: string;
		resolution?: string;
		count: number;
		requestedCount?: number;
		batchId?: string;
		batchIndex?: number;
		category?: string;
		transparentBackground?: boolean;
		referenceStorageKeys?: string[];
		source?: {
			kind: "director";
			directorNodeId: string;
			captureId: string;
			cameraId: string;
			configNodeId: string;
		};
	};
};

export type ServerVideoGenerationInput = {
	id?: string;
	projectId?: string;
	prompt: string;
	providerId: string;
	model?: string;
	parameters: {
		size?: string;
		seconds?: number;
		ratio: string;
		resolution: string;
		generateAudio?: boolean;
		watermark?: boolean;
		frameMode?: "references" | "first-last";
		negativePrompt?: string;
		mode?: "std" | "pro" | "4k";
		multiShot?: boolean;
		shotType?: "intelligence" | "customize";
		shots?: Array<{ index: number; prompt: string; duration: number }>;
		elements?: Array<{ name: string; description: string; imageUrls: string[] }>;
		referenceStorageKeys?: string[];
	};
};

export type ServerAudioGenerationInput = {
	id?: string;
	projectId?: string;
	prompt: string;
	providerId: string;
	model?: string;
	parameters: { voice: string; format: string; speed?: number; instructions?: string };
};

export type GenerationJobPollingOptions = {
	signal?: AbortSignal;
	intervalMs?: number;
	getJob?: (id: string) => Promise<GenerationJob | undefined>;
	wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	onUpdate?: (job: GenerationJob) => void;
};

export function usesBrowserE2EGeneration(): boolean {
	const runtime = globalThis as typeof globalThis & { __OPENBOARD_E2E_BROWSER_GENERATION__?: boolean };
	return runtime.__OPENBOARD_E2E_BROWSER_GENERATION__ === true &&
		typeof location !== "undefined" &&
		(location.hostname === "127.0.0.1" || location.hostname === "localhost");
}

export function usesServerGenerationJobs(): boolean {
	return !usesBrowserE2EGeneration();
}

export function isServerOwnedGenerationJob(job: GenerationJob): boolean {
	return job.parameters.executor === "server" || job.parameters.executor === "workflow" ||
		(job.kind === "film-stage" && job.parameters.executor === "film-stage") ||
		(job.kind === "export" && job.parameters.executor === "film-export");
}

function validatePagination(page: number, pageSize: number): void {
  if (!Number.isInteger(page) || page < 1) throw new Error("page must be a positive integer");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("pageSize must be between 1 and 100");
  }
}

function matchesGenerationStatus(job: GenerationJob, status: string): boolean {
  if (status === "" || status === "all") return true;
  if (status === "succeeded") {
    return job.status === "succeeded" || job.status === "running" || job.status === "queued";
  }
  if (status === "failed") return job.status === "failed" || job.status === "cancelled";
  return job.status === status;
}

export function paginateGenerationJobs(
  jobs: GenerationJob[],
  query: GenerationJobQuery,
): GenerationJobPage {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  validatePagination(page, pageSize);
  const rawCategory = query.category ?? "";
  const normalizedCategory = rawCategory && rawCategory.trim() !== WORKBENCH_ALL_CATEGORIES
    ? normalizeWorkbenchCategory(rawCategory)
    : "";
  const scoped = jobs
    .filter((job) => !query.projectId || job.projectId === query.projectId)
    .filter((job) => !query.kind || job.kind === query.kind)
    .filter((job) => matchesGenerationStatus(job, query.status ?? ""));
  const filtered = scoped
    .filter((job) => !normalizedCategory || normalizeWorkbenchCategory(job.parameters.category) === normalizedCategory)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    page,
    pageSize,
    total: filtered.length,
    categories: workbenchCategories(scoped),
  };
}

export function findInterruptedGenerationJobs(
  jobs: readonly GenerationJob[],
  ownerClientId: string,
  liveActivityIds: ReadonlySet<string>,
  now = Date.now(),
): GenerationJob[] {
  if (!ownerClientId) return [];
  return jobs
    .filter((job) => {
		if (job.status !== "running" || isServerOwnedGenerationJob(job) || liveActivityIds.has(job.id)) return false;
      if (job.parameters.ownerClientId === ownerClientId) return true;
      return now - Date.parse(job.updatedAt) >= LEGACY_GENERATION_GRACE_MS;
    })
    .map((job) => structuredClone(job));
}

export function validateGenerationJob(job: GenerationJob): GenerationJob {
	const kinds = new Set<GenerationKind>(["text", "image", "video", "audio", "workflow", "export", "film-stage"]);
  const statuses = new Set<GenerationStatus>(["queued", "running", "succeeded", "failed", "cancelled", "deleted"]);
  if (!ID.test(job.id) || (job.projectId && !ID.test(job.projectId)) || !kinds.has(job.kind) ||
    !statuses.has(job.status) || job.prompt.length > 100_000 || (job.providerId?.length ?? 0) > 500 ||
    (job.model?.length ?? 0) > 500 || (job.error?.length ?? 0) > 10_000 ||
    Number.isNaN(Date.parse(job.createdAt)) || Number.isNaN(Date.parse(job.updatedAt))) {
    throw new Error("invalid generation job");
  }
  validateJsonObject(job.parameters, { label: "generation parameters", maxBytes: 256 * 1024, maxDepth: 20, maxEntries: 20_000 });
  validateJsonObject(job.result, { label: "generation result", maxBytes: 512 * 1024, maxDepth: 20, maxEntries: 20_000 });
  const validated = structuredClone(job);
  return validated.kind === "workflow" ? validateWorkflowGenerationJob(validated) : validated;
}

/** Longest server reason worth showing; anything longer is not a message. */
const MAX_SERVER_REASON_LENGTH = 300;

/**
 * Builds the error for a failed generation request. Server refusals such as a
 * disabled cloud channel or a model outside the tenant allow list explain what
 * the user must change, so the reason is preserved rather than collapsed into a
 * bare status code. An HTML error page or an oversized body is not a usable
 * reason and falls back to the status.
 */
export function generationRequestError(status: number, body: string): Error {
  const reason = body.trim();
  const usable = reason.length > 0 &&
    reason.length <= MAX_SERVER_REASON_LENGTH &&
    !reason.startsWith("<");
  return Object.assign(new Error(usable
    ? `Generation request failed: ${reason}`
    : `Generation history failed: HTTP ${status}`), { status });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(path, init);
  if (!response.ok) {
    // Reading the body must never mask the original failure.
    const body = await response.text().catch(() => "");
    throw generationRequestError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listGenerationJobs(query: GenerationJobQuery = {}): Promise<GenerationJobPage> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  validatePagination(page, pageSize);
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.kind) params.set("kind", query.kind);
  if (query.status) params.set("status", query.status);
  if (query.category && query.category.trim() !== WORKBENCH_ALL_CATEGORIES) {
    params.set("category", normalizeWorkbenchCategory(query.category));
  }
  if (query.includeDeleted) params.set("includeDeleted", "1");
  const result = await api<GenerationJobPage>(`generation-jobs?${params}`);
  return { ...result, items: result.items.map(validateGenerationJob) };
}

export async function getGenerationJob(id: string): Promise<GenerationJob | undefined> {
  if (!ID.test(id)) throw new Error("invalid generation job id");
  try {
    return validateGenerationJob(await api<GenerationJob>(`generation-jobs/${encodeURIComponent(id)}`));
  } catch (error) {
    if (error instanceof Error && (error as Error & { status?: number }).status === 404) return undefined;
    throw error;
  }
}

export async function createGenerationJob(input: NewGenerationJob): Promise<GenerationJob> {
  const timestamp = nowIso();
  const job = validateGenerationJob({ ...input, id: input.id ?? uid("job"), createdAt: timestamp, updatedAt: timestamp });
  return validateGenerationJob(await api<GenerationJob>("generation-jobs", { method: "POST", body: JSON.stringify(job) }));
}

export async function createServerImageGenerationJob(input: ServerImageGenerationInput): Promise<GenerationJob> {
	return createServerGenerationJob("image", input);
}

export async function createServerVideoGenerationJob(input: ServerVideoGenerationInput): Promise<GenerationJob> {
	return createServerGenerationJob("video", input);
}

export async function createServerAudioGenerationJob(input: ServerAudioGenerationInput): Promise<GenerationJob> {
	return createServerGenerationJob("audio", input);
}

async function createServerGenerationJob(
	kind: "image" | "video" | "audio",
	input: ServerImageGenerationInput | ServerVideoGenerationInput | ServerAudioGenerationInput,
): Promise<GenerationJob> {
	const id = input.id ?? uid("job");
	if (!ID.test(id) || (input.projectId && !ID.test(input.projectId)) || !ID.test(input.providerId)) {
		throw new Error("invalid server image generation input");
	}
	return validateGenerationJob(await api<GenerationJob>(`generation-jobs/${kind}`, {
		method: "POST",
		body: JSON.stringify({ ...input, id }),
	}));
}

export async function cancelServerGenerationJob(id: string): Promise<GenerationJob> {
	if (!ID.test(id)) throw new Error("invalid generation job id");
	return validateGenerationJob(await api<GenerationJob>(`generation-jobs/${encodeURIComponent(id)}/cancel`, {
		method: "POST",
	}));
}

function defaultPollingWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const complete = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(complete, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function waitForGenerationJob(
	id: string,
	options: GenerationJobPollingOptions = {},
): Promise<GenerationJob> {
	if (!ID.test(id)) throw new Error("invalid generation job id");
	const read = options.getJob ?? getGenerationJob;
	const wait = options.wait ?? defaultPollingWait;
	const intervalMs = options.intervalMs ?? 1_000;
	if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
		throw new Error("invalid generation polling interval");
	}
	for (;;) {
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		const job = await read(id);
		if (!job) throw new Error("generation job not found");
		options.onUpdate?.(job);
		if (
			job.status === "succeeded" ||
			job.status === "failed" ||
			job.status === "cancelled" ||
			job.status === "deleted"
		) {
			return job;
		}
		await wait(intervalMs, options.signal);
	}
}

export async function updateGenerationJob(id: string, patch: Partial<GenerationJob>): Promise<GenerationJob> {
  const current = await getGenerationJob(id);
  if (!current) throw new Error("generation job not found");
  const job = validateGenerationJob({ ...current, ...patch, id, createdAt: current.createdAt, updatedAt: nowIso() });
  return validateGenerationJob(await api<GenerationJob>(`generation-jobs/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(job) }));
}

/**
 * Transition a browser recovery candidate only if its observed running
 * version is still current. A 409 means another actor won the race, so read
 * the latest job for the caller instead of overwriting it with a stale failure.
 */
export async function failGenerationJobIfUnchanged(
  job: GenerationJob,
  error: string,
): Promise<GenerationJob | undefined> {
  if (!ID.test(job.id)) throw new Error("invalid generation job id");
  try {
    return validateGenerationJob(await api<GenerationJob>(
      `generation-jobs/${encodeURIComponent(job.id)}/recover`,
      {
        method: "POST",
        body: JSON.stringify({ expectedUpdatedAt: job.updatedAt, error }),
      },
    ));
  } catch (cause) {
    if (cause instanceof Error && (cause as Error & { status?: number }).status === 409) {
      return getGenerationJob(job.id);
    }
    throw cause;
  }
}

export async function deleteGenerationJob(id: string): Promise<void> {
  if (!ID.test(id)) throw new Error("invalid generation job id");
  await api<void>(`generation-jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function uniqueGenerationJobIds(ids: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

/** Delete many history jobs in one request (server) or local batch. */
export async function deleteGenerationJobs(ids: readonly string[]): Promise<number> {
  const unique = uniqueGenerationJobIds(ids);
  if (!unique.length) return 0;
  if (unique.length > 100) throw new Error("too many generation job ids");
  const result = await api<{ deleted?: number }>("generation-jobs/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids: unique }),
  });
  return Number(result?.deleted ?? 0);
}

export function selectGenerationJobsForProject(
  jobs: readonly GenerationJob[],
  projectId: string,
): GenerationJob[] {
  return jobs.filter((job) => job.projectId === projectId);
}

export function selectGenerationJobsForNodeCleanup(
  jobs: readonly GenerationJob[],
  projectId: string | undefined,
  nodeIds: ReadonlySet<string>,
  nodeJobIds: ReadonlySet<string> = new Set(),
): GenerationJob[] {
  if (!nodeIds.size && !nodeJobIds.size) return [];
  return jobs.filter((job) => {
    if (projectId && job.projectId && job.projectId !== projectId) return false;
    const linkedNodeId = typeof job.parameters.nodeId === "string" ? job.parameters.nodeId : undefined;
    return Boolean((linkedNodeId && nodeIds.has(linkedNodeId)) || nodeJobIds.has(job.id));
  });
}

export async function deleteGenerationJobsForProject(projectId: string): Promise<number> {
  if (!ID.test(projectId)) throw new Error("invalid project id");
  const result = await api<{ deleted?: number }>(
    `generation-jobs/project/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );
  return Number(result?.deleted ?? 0);
}

/** Remove jobs owned by deleted canvas nodes. Active server jobs are cancelled first. */
export async function deleteGenerationJobsForNodeIds(
  projectId: string | undefined,
  nodeIds: ReadonlySet<string>,
  options: { nodeJobIds?: ReadonlySet<string> } = {},
): Promise<number> {
  const targets = selectGenerationJobsForNodeCleanup(
    await listAllGenerationJobs(),
    projectId,
    nodeIds,
    options.nodeJobIds ?? new Set(),
  );
  let deleted = 0;
  for (const job of targets) {
    try {
      if (isServerOwnedGenerationJob(job) && (job.status === "queued" || job.status === "running")) {
        await cancelServerGenerationJob(job.id);
      }
      await deleteGenerationJob(job.id);
      deleted += 1;
    } catch {
      // Best-effort cleanup; board deletion should still succeed.
    }
  }
  return deleted;
}

export function generationJobListExhausted(
  page: number,
  pageSize: number,
  itemCount: number,
  total: number,
): boolean {
  if (!Number.isSafeInteger(page) || page < 1) return true;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) return true;
  if (!Number.isSafeInteger(itemCount) || itemCount < pageSize) return true;
  if (Number.isSafeInteger(total) && page * pageSize >= total) return true;
  return page >= 1_000;
}

export async function listAllGenerationJobs(options: { includeDeleted?: boolean } = {}): Promise<GenerationJob[]> {
  const jobs: GenerationJob[] = [];
  let page = 1;
  while (true) {
    const result = await listGenerationJobs({
      page,
      pageSize: 100,
      includeDeleted: options.includeDeleted,
    });
    jobs.push(...result.items);
    if (generationJobListExhausted(page, result.pageSize, result.items.length, result.total)) return jobs;
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
  await api<void>("generation-jobs", { method: "PUT", body: JSON.stringify(validated) });
}

export function collectGenerationStorageKeysFromJobs(
  jobs: readonly GenerationJob[],
): Set<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (job.kind === "workflow") {
      for (const key of collectWorkflowJobStorageKeys(job)) keys.add(key);
      continue;
    }
    const references = Array.isArray(job.parameters.referenceStorageKeys)
      ? job.parameters.referenceStorageKeys
      : [];
    for (const key of references) if (typeof key === "string") keys.add(key);
    const items = Array.isArray(job.result.items) ? job.result.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as { storageKey?: unknown; thumbnailStorageKey?: unknown };
      if (typeof record.storageKey === "string") keys.add(record.storageKey);
      if (typeof record.thumbnailStorageKey === "string") keys.add(record.thumbnailStorageKey);
    }
  }
  return keys;
}

export function findUnreferencedGenerationStorageKeys(
  removed: GenerationJob,
  remaining: readonly GenerationJob[],
  externallyReferenced: ReadonlySet<string>,
): Set<string> {
  const candidates = collectGenerationStorageKeysFromJobs([removed]);
  const live = collectGenerationStorageKeysFromJobs(remaining);
  for (const key of externallyReferenced) live.add(key);
  return new Set([...candidates].filter((key) => !live.has(key)));
}

export async function collectGenerationStorageKeys(): Promise<Set<string>> {
  return collectGenerationStorageKeysFromJobs(await listAllGenerationJobs({ includeDeleted: true }));
}
