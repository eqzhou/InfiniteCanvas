import { authFetch } from "@/services/auth-session";
import { cancelServerGenerationJob, getGenerationJob } from "@/services/generation-jobs";
import type { FilmAssetKind, FilmDocument, FilmProjectionCommit, FilmStageKind, FilmTask, FilmTimeline } from "@/types/film";

export class FilmAPIError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "FilmAPIError";
  }
}

export type FilmStatus = {
  document: FilmDocument;
  recordRevision: number;
  capabilities: FilmCapabilities;
  rehydration?: { migratedStorageKeys: string[] };
};

export type FilmRestoreMediaProvenance =
  | { kind: "shot"; entityId: string; field: "imageStorageKey" | "audioStorageKey" | "videoStorageKey" }
  | { kind: "asset"; entityId: string; field: "mediaStorageKey" }
  | { kind: "timeline"; entityId: string; field: "source" }
  | { kind: "deliverable"; entityId: string; field: "storageKey" };

export type FilmRestoreMedia = {
  storageKey: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  objectVersion: string;
  provenance: FilmRestoreMediaProvenance[];
};

export type FilmCapabilities = {
  available: boolean;
  reason: string;
  plainTextImport: boolean;
  markdownImport: boolean;
  docxImport: boolean;
  pdfImport: boolean;
  fileUploadImport: boolean;
  maxImportBytes: number;
  stageGeneration: boolean;
  generationJobs: boolean;
  generationStages: FilmStageKind[];
  assetBundleExport: boolean;
  mp4Export: boolean;
  mp4Diagnostic: string;
  agentOperations: FilmAgentOperation[];
};

export type FilmAgentOperation = "status" | "list" | "validate" | "run_stage";
export type FilmGenerationJobStatus = "queued" | "running" | "needs_review" | "failed" | "canceled";
export type FilmGenerationJob = {
  id: string;
  parentJobId?: string;
  shotId?: string;
  stage: FilmStageKind;
  status: FilmGenerationJobStatus;
  title: string;
  progress?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type FilmGenerationConfigValue = string | number | boolean | string[];

export type FilmStageRunRequest = {
  revision: number;
  shotIds?: string[];
  shotRange?: { from: number; to: number };
  provider: string;
  model: string;
  generationConfig: Record<string, FilmGenerationConfigValue>;
  idempotencyKey: string;
};

export type FilmGenerationConfig = Partial<{
  size: string; quality: string; ratio: string; resolution: string; seconds: number;
  generateAudio: boolean; watermark: boolean; negativePrompt: string;
  referenceStorageKeys: string[]; voice: string; format: string; speed: number; instructions: string;
}>;

export type FilmProjectionPlan = {
  projectId: string;
  recordRevision: number;
  projectionRevision: number;
  targets: Array<{
    projectionKey: string;
    revision: number;
    type: "group" | "text";
    title: string;
    content: string;
  }>;
};

type RawFilmCapabilities = Omit<Partial<Omit<FilmCapabilities, "agentOperations">>, "generationStages"> & {
  agentOperations?: unknown;
  importMaxBytes?: unknown;
  generationStages?: unknown;
};

const DEFAULT_MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const SAFE_AGENT_OPERATIONS = new Set<FilmAgentOperation>(["status", "list", "validate", "run_stage"]);
const capabilitiesByProject = new Map<string, FilmCapabilities>();

export function normalizeFilmCapabilities(raw: RawFilmCapabilities | null | undefined): FilmCapabilities {
  const operations = Array.isArray(raw?.agentOperations)
    ? raw.agentOperations.filter((value): value is FilmAgentOperation => typeof value === "string" && SAFE_AGENT_OPERATIONS.has(value as FilmAgentOperation))
    : ["status", "list", "validate", "run_stage"] satisfies FilmAgentOperation[];
  const supportedGenerationStages: FilmStageKind[] = ["storyboard", "audio", "video"];
  const generationStages = Array.isArray(raw?.generationStages)
    ? raw.generationStages.filter((stage): stage is FilmStageKind => supportedGenerationStages.includes(stage as FilmStageKind))
    : raw?.generationStages && typeof raw.generationStages === "object"
      ? supportedGenerationStages.filter((stage) => (raw.generationStages as Record<string, unknown>)[stage] === true)
      : raw?.stageGeneration ? supportedGenerationStages : [];
  return {
    available: raw?.available ?? true,
    reason: typeof raw?.reason === "string" ? raw.reason : "",
    plainTextImport: raw?.plainTextImport ?? true,
    markdownImport: raw?.markdownImport ?? true,
    docxImport: raw?.docxImport ?? false,
    pdfImport: raw?.pdfImport ?? false,
    fileUploadImport: raw?.fileUploadImport ?? Boolean(raw?.docxImport || raw?.pdfImport),
    maxImportBytes: typeof (raw?.maxImportBytes ?? raw?.importMaxBytes) === "number" && Number(raw?.maxImportBytes ?? raw?.importMaxBytes) > 0
      ? Math.min(Number(raw?.maxImportBytes ?? raw?.importMaxBytes), DEFAULT_MAX_IMPORT_BYTES)
      : DEFAULT_MAX_IMPORT_BYTES,
    stageGeneration: raw?.stageGeneration ?? false,
    generationJobs: raw?.generationJobs ?? false,
    generationStages,
    assetBundleExport: raw?.assetBundleExport ?? false,
    mp4Export: raw?.mp4Export ?? false,
    mp4Diagnostic: typeof raw?.mp4Diagnostic === "string" ? raw.mp4Diagnostic : "MP4 export is disabled",
    agentOperations: operations,
  };
}

function filmPath(projectId: string, suffix = ""): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) {
    throw new Error("Invalid film project id");
  }
  return `film/projects/${encodeURIComponent(projectId)}${suffix}`;
}

async function readFilmResponse(projectId: string, response: Response): Promise<FilmStatus> {
  const value = await response.json().catch(() => null) as {
    data?: unknown;
    meta?: { recordRevision?: unknown; rehydration?: { migratedStorageKeys?: unknown } };
    capabilities?: RawFilmCapabilities;
    error?: { code?: unknown; message?: unknown };
  } | null;
  if (!response.ok) {
    const code = typeof value?.error?.code === "string" ? value.error.code : "film_request_failed";
    const message = typeof value?.error?.message === "string"
      ? value.error.message
      : `Film request failed: HTTP ${response.status}`;
    throw new FilmAPIError(response.status, code, message);
  }
  const document = value?.data as Partial<FilmDocument> | undefined;
  const recordRevision = value?.meta?.recordRevision;
  if (
    !document || document.schemaVersion !== 1 || typeof document.projectId !== "string" ||
    typeof document.revision !== "number" || !Array.isArray(document.episodes) ||
    !Array.isArray(document.shots) || !Array.isArray(document.assets) ||
    !document.timeline || typeof recordRevision !== "number"
  ) {
    throw new Error("Film server response is invalid");
  }
  const capabilities = value?.capabilities
    ? normalizeFilmCapabilities(value.capabilities)
    : capabilitiesByProject.get(projectId) ?? normalizeFilmCapabilities(undefined);
  capabilitiesByProject.set(projectId, capabilities);
  const migratedStorageKeys = value?.meta?.rehydration?.migratedStorageKeys;
  return {
    document: document as FilmDocument,
    recordRevision,
    capabilities,
    ...(Array.isArray(migratedStorageKeys) && migratedStorageKeys.every((key) => typeof key === "string")
      ? { rehydration: { migratedStorageKeys: [...new Set(migratedStorageKeys)] } }
      : {}),
  };
}

async function requestFilm(projectId: string, suffix: string, init?: RequestInit): Promise<FilmStatus> {
  return readFilmResponse(projectId, await authFetch(filmPath(projectId, suffix), init));
}

export function loadFilmStatus(projectId: string): Promise<FilmStatus> {
  return requestFilm(projectId, "/status");
}

export async function loadFilmCapabilities(): Promise<FilmCapabilities> {
  const response = await authFetch("film/capabilities");
  const payload = await response.json().catch(() => null) as { data?: Partial<FilmCapabilities> } | null;
  if (!response.ok || typeof payload?.data?.available !== "boolean") {
    throw new Error("Film capabilities are unavailable");
  }
  return normalizeFilmCapabilities(payload.data);
}

export function createFilmProduction(projectId: string): Promise<FilmStatus> {
  return requestFilm(projectId, "", { method: "POST", body: "{}" });
}

export function importFilmManuscript(
  projectId: string,
  input: { revision: number; text: string; format: "text" | "txt" | "markdown"; originalName?: string },
): Promise<FilmStatus> {
  return requestFilm(projectId, "/source/text", { method: "PUT", body: JSON.stringify(input) });
}

export function importFilmManuscriptFile(
  projectId: string,
  input: { revision: number; format: "docx" | "pdf"; file: File },
): Promise<FilmStatus> {
  const body = new FormData();
  body.set("revision", String(input.revision));
  body.set("file", input.file, input.file.name);
  return requestFilm(projectId, "/source/import", { method: "POST", body });
}

export function updateFilmEpisode(
  projectId: string,
  episodeId: string,
  patch: { revision: number; title?: string; synopsis?: string; order?: number },
): Promise<FilmStatus> {
  return requestFilm(projectId, `/episodes/${encodeURIComponent(episodeId)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function createFilmScene(
  projectId: string,
  input: { episodeId: string; heading: string; synopsis?: string; order?: number },
): Promise<FilmStatus> {
  return requestFilm(projectId, "/scenes", { method: "POST", body: JSON.stringify(input) });
}

export function updateFilmScene(
  projectId: string,
  sceneId: string,
  patch: { revision: number; episodeId?: string; heading?: string; synopsis?: string; order?: number },
): Promise<FilmStatus> {
  return requestFilm(projectId, `/scenes/${encodeURIComponent(sceneId)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function deleteFilmScene(projectId: string, sceneId: string, revision: number): Promise<FilmStatus> {
  return requestFilm(projectId, `/scenes/${encodeURIComponent(sceneId)}?revision=${revision}`, { method: "DELETE" });
}

export function updateFilmShot(
  projectId: string,
  shotId: string,
  patch: {
    revision: number;
    title?: string;
    description?: string;
    durationSeconds?: number;
    subtitle?: string;
    identityVersionIds?: string[];
    styleAssetId?: string;
  },
): Promise<FilmStatus> {
  return requestFilm(projectId, `/shots/${encodeURIComponent(shotId)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function createFilmAsset(
  projectId: string,
  input: { kind: FilmAssetKind; title: string; description?: string; parentAssetId?: string },
): Promise<FilmStatus> {
  return requestFilm(projectId, "/assets", { method: "POST", body: JSON.stringify(input) });
}

export function updateFilmAsset(
  projectId: string,
  assetId: string,
  patch: {
    revision: number;
    kind?: FilmAssetKind;
    title?: string;
    description?: string;
    parentAssetId?: string;
    mediaStorageKey?: string;
    voice?: string;
    stylePrompt?: string;
    aspectRatio?: string;
  },
): Promise<FilmStatus> {
  return requestFilm(projectId, `/assets/${encodeURIComponent(assetId)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function changeFilmStage(
  projectId: string,
  stage: string,
  action: "run" | "approve" | "reject",
  revision: number,
): Promise<FilmStatus> {
  return requestFilm(projectId, `/stages/${encodeURIComponent(stage)}/${action}`, { method: "POST", body: JSON.stringify({ revision }) });
}

export function requestFilmStageRun(
  projectId: string,
  stage: FilmStageKind,
  input: FilmStageRunRequest,
): Promise<FilmStatus> {
  return requestFilm(projectId, `/stages/${encodeURIComponent(stage)}/run`, {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({
      revision: input.revision,
      shotIds: input.shotIds,
      shotRange: input.shotRange ? { start: input.shotRange.from, end: input.shotRange.to } : undefined,
      providerId: input.provider,
      model: input.model,
      config: sanitizeFilmGenerationConfig(input.generationConfig),
      idempotencyKey: input.idempotencyKey,
    }),
  });
}

const FILM_GENERATION_CONFIG_KEYS = new Set([
  "size", "quality", "ratio", "resolution", "seconds", "generateAudio", "watermark",
  "negativePrompt", "referenceStorageKeys", "voice", "format", "speed", "instructions",
]);

function sanitizeFilmGenerationConfig(config: Record<string, FilmGenerationConfigValue>): FilmGenerationConfig {
  return Object.fromEntries(Object.entries(config).filter(([key]) => FILM_GENERATION_CONFIG_KEYS.has(key))) as FilmGenerationConfig;
}

export function resolveFilmStageSelection(
  document: FilmDocument,
  episodeRange?: { from: number; to: number },
  shotRange: { from: number; to: number } = { from: 0, to: 0 },
): Pick<FilmStageRunRequest, "shotIds" | "shotRange"> {
  const normalizedShots = { from: Math.max(0, Math.trunc(shotRange.from)), to: Math.max(0, Math.trunc(shotRange.to)) };
  if (normalizedShots.to < normalizedShots.from) throw new Error("镜头范围终点不能小于起点");
  if (!episodeRange) return { shotRange: normalizedShots };
  const fromOrder = Math.max(0, Math.trunc(episodeRange.from) - 1);
  const toOrder = Math.max(0, Math.trunc(episodeRange.to) - 1);
  if (toOrder < fromOrder) throw new Error("分集范围终点不能小于起点");
  const episodeIds = new Set(document.episodes.filter((episode) => episode.order >= fromOrder && episode.order <= toOrder).map((episode) => episode.id));
  const sceneIds = new Set(document.scenes.filter((scene) => episodeIds.has(scene.episodeId)).map((scene) => scene.id));
  const shotIds = document.shots
    .filter((shot) => sceneIds.has(shot.sceneId) && shot.order >= normalizedShots.from && shot.order <= normalizedShots.to)
    .map((shot) => shot.id);
  if (!shotIds.length) throw new Error("所选分集与镜头范围没有可生成镜头");
  return { shotIds };
}

function normalizeFilmGenerationJob(value: unknown): FilmGenerationJob {
  const job = value as Omit<Partial<FilmGenerationJob>, "status"> & { status?: string };
  const stageKinds = new Set<FilmStageKind>(["decompose", "script", "storyboard", "audio", "video", "compose", "delivery"]);
  const status = job.status === "succeeded" ? "needs_review" : job.status === "cancelled" ? "canceled" : job.status;
  if (
    typeof job.id !== "string" || !stageKinds.has(job.stage as FilmStageKind) ||
    !["queued", "running", "needs_review", "failed", "canceled"].includes(status ?? "") ||
    typeof job.title !== "string" || typeof job.createdAt !== "string" || typeof job.updatedAt !== "string"
  ) throw new Error("Film generation job response is invalid");
  return { ...job, stage: job.stage as FilmStageKind, status } as FilmGenerationJob;
}

function filmTaskStatus(status: FilmTask["status"]): FilmGenerationJobStatus {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "draft") return "queued";
  return "needs_review";
}

function normalizeFilmGenerationTask(value: unknown): FilmGenerationJob {
  const task = value as Partial<FilmTask>;
  const statuses = new Set<FilmTask["status"]>(["draft", "running", "needs_review", "approved", "failed", "canceled"]);
  if (
    typeof task.id !== "string" || typeof task.stage !== "string" || typeof task.status !== "string" ||
    !statuses.has(task.status as FilmTask["status"]) ||
    typeof task.title !== "string" || typeof task.createdAt !== "string" || typeof task.updatedAt !== "string"
  ) throw new Error("Film generation task response is invalid");
  return normalizeFilmGenerationJob({
    id: task.id,
    stage: task.stage,
    status: filmTaskStatus(task.status as FilmTask["status"]),
    title: task.title,
    ...(typeof task.progress === "number" ? { progress: task.progress } : {}),
    ...(typeof task.error === "string" && task.error ? { error: task.error } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

function buildFilmGenerationHierarchy(tasks: readonly unknown[], jobs: readonly unknown[]): FilmGenerationJob[] {
  const parents = tasks.map(normalizeFilmGenerationTask);
  const tasksByGenerationJob = new Map<string, string>();
  for (const value of tasks) {
    const task = value as Partial<FilmTask>;
    if (typeof task.generationJobId === "string" && typeof task.id === "string") {
      tasksByGenerationJob.set(task.generationJobId, task.id);
    }
  }
  const children = jobs.map((value) => {
    const child = normalizeFilmGenerationJob(value);
    const parentJobId = child.parentJobId ?? tasksByGenerationJob.get(child.id);
    return parentJobId ? { ...child, parentJobId } : child;
  });
  const parentIds = new Set(parents.map((parent) => parent.id));
  return [
    ...parents.flatMap((parent) => [parent, ...children.filter((child) => child.parentJobId === parent.id)]),
    ...children.filter((child) => !child.parentJobId || !parentIds.has(child.parentJobId)),
  ];
}

async function requestFilmJobData(projectId: string, suffix: string, init?: RequestInit): Promise<unknown> {
  const response = await authFetch(filmPath(projectId, suffix), init);
  const payload = await response.json().catch(() => null) as { data?: unknown; error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new FilmAPIError(response.status, payload?.error?.code ?? "film_job_request_failed", payload?.error?.message ?? `Film job request failed: HTTP ${response.status}`);
  return payload?.data;
}

export async function listFilmGenerationJobs(projectId: string, knownStatus?: FilmStatus): Promise<FilmGenerationJob[]> {
  try {
    const data = await requestFilmJobData(projectId, "/generation-jobs");
    if (!Array.isArray(data)) {
      if (!data || typeof data !== "object") throw new Error("Film generation jobs response is invalid");
      const hierarchy = data as { tasks?: unknown; generationJobs?: unknown; items?: unknown };
      const legacyJobs = hierarchy.generationJobs ?? hierarchy.items;
      if (!Array.isArray(legacyJobs)) throw new Error("Film generation jobs response is invalid");
      const tasks = Array.isArray(hierarchy.tasks)
        ? hierarchy.tasks
        : (knownStatus?.document.tasks ?? []).filter((task) => task.generationJobId);
      return buildFilmGenerationHierarchy(tasks, legacyJobs);
    }
    return data.map(normalizeFilmGenerationJob);
  } catch (cause) {
    if (!(cause instanceof FilmAPIError) || cause.status !== 404) throw cause;
    const status = knownStatus ?? await loadFilmStatus(projectId);
    const tasks = status.document.tasks.filter((task) => task.generationJobId && task.shotId);
    const children = (await Promise.all(tasks.map(async (task) => {
      const job = await getGenerationJob(task.generationJobId!);
      if (!job) return null;
      return normalizeFilmGenerationJob({
        id: job.id,
        parentJobId: `stage-${task.stage}`,
        shotId: task.shotId,
        stage: task.stage,
        status: job.status,
        title: task.title,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    }))).filter((job): job is FilmGenerationJob => job !== null);
    const stages = [...new Set(children.map((job) => job.stage))];
    const parents = stages.map((stage): FilmGenerationJob => {
      const stageChildren = children.filter((job) => job.stage === stage);
      const status: FilmGenerationJobStatus = stageChildren.some((job) => job.status === "running") ? "running"
        : stageChildren.some((job) => job.status === "queued") ? "queued"
          : stageChildren.some((job) => job.status === "failed") ? "failed"
            : stageChildren.every((job) => job.status === "canceled") ? "canceled" : "needs_review";
      return { id: `stage-${stage}`, stage, status, title: `${stage} generation`, createdAt: stageChildren[0]!.createdAt, updatedAt: stageChildren.at(-1)!.updatedAt };
    });
    return parents.flatMap((parent) => [parent, ...children.filter((child) => child.stage === parent.stage)]);
  }
}

export async function retryFilmGenerationJob(projectId: string, jobId: string): Promise<FilmGenerationJob | FilmStatus> {
  try {
    return normalizeFilmGenerationJob(await requestFilmJobData(projectId, `/generation-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" }));
  } catch (cause) {
    if (!(cause instanceof FilmAPIError) || cause.status !== 404) throw cause;
    const [status, job] = await Promise.all([loadFilmStatus(projectId), getGenerationJob(jobId)]);
    const task = status.document.tasks.find((candidate) => candidate.generationJobId === jobId && candidate.shotId);
    if (!task || !job) throw new Error("Film generation retry binding is unavailable");
    if (job.status !== "failed" && job.status !== "cancelled") throw new Error("Only failed or canceled film generation jobs can be retried");
    const stage = status.document.stages.find((candidate) => candidate.id === task.stage);
    if (!stage) throw new Error("Film generation retry stage is unavailable");
    const config = sanitizeFilmGenerationConfig(job.parameters as Record<string, FilmGenerationConfigValue>);
    return requestFilmStageRun(projectId, task.stage, {
      revision: stage.revision,
      shotIds: [task.shotId!],
      provider: job.providerId ?? "",
      model: job.model ?? "",
      generationConfig: config as Record<string, FilmGenerationConfigValue>,
      idempotencyKey: stableFilmIdempotencyKey("retry", projectId, `${task.stage}-${job.id}-${job.updatedAt}`, stage.revision),
    });
  }
}

export function syncFilmStage(projectId: string, stage: FilmStageKind, revision: number): Promise<FilmStatus> {
  return requestFilm(projectId, `/stages/${encodeURIComponent(stage)}/sync`, { method: "POST", body: JSON.stringify({ revision }) });
}

type FilmStagePollingOptions = {
  signal?: AbortSignal;
  maxPolls?: number;
  intervalMs?: number;
  loadStatus?: typeof loadFilmStatus;
  listJobs?: typeof listFilmGenerationJobs;
  sync?: typeof syncFilmStage;
};

function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Film generation polling aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Film generation polling aborted")); }, { once: true });
  });
}

export async function waitForFilmGenerationStage(
  projectId: string,
  stage: FilmStageKind,
  options: FilmStagePollingOptions = {},
): Promise<FilmStatus> {
  const maxPolls = options.maxPolls ?? 120;
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 600) throw new Error("Invalid film generation polling limit");
  const load = options.loadStatus ?? loadFilmStatus;
  const list = options.listJobs ?? listFilmGenerationJobs;
  const sync = options.sync ?? syncFilmStage;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (options.signal?.aborted) throw new Error("Film generation polling aborted");
    const status = await load(projectId);
    const jobs = (await list(projectId, status)).filter((job) => job.stage === stage && Boolean(job.shotId));
    if (jobs.length && jobs.every((job) => !["queued", "running"].includes(job.status))) {
      const stageRevision = status.document.stages.find((candidate) => candidate.id === stage)?.revision;
      if (!stageRevision) throw new Error("Film generation stage is unavailable");
      return sync(projectId, stage, stageRevision);
    }
    if (poll + 1 < maxPolls) await waitForDelay(options.intervalMs ?? 1_000, options.signal);
  }
  throw new Error("Film generation polling limit reached");
}

export async function cancelFilmGenerationJob(projectId: string, jobId: string): Promise<FilmGenerationJob> {
  try {
    return normalizeFilmGenerationJob(await requestFilmJobData(projectId, `/generation-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }));
  } catch (cause) {
    if (!(cause instanceof FilmAPIError) || cause.status !== 404) throw cause;
    const job = await cancelServerGenerationJob(jobId);
    const status = await loadFilmStatus(projectId);
    const task = status.document.tasks.find((candidate) => candidate.generationJobId === jobId);
    if (!task) throw new Error("Film generation task is unavailable");
    return normalizeFilmGenerationJob({ id: job.id, parentJobId: `stage-${task.stage}`, shotId: task.shotId, stage: task.stage, status: job.status, title: task.title, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt });
  }
}

export function validateFilm(projectId: string): Promise<FilmStatus> {
  return requestFilm(projectId, "/validate", { method: "POST", body: "{}" });
}

export function applyFilmRepair(projectId: string, repairId: string, revision: number): Promise<FilmStatus> {
  return requestFilm(projectId, `/repairs/${encodeURIComponent(repairId)}/apply`, {
    method: "POST",
    body: JSON.stringify({ revision, approved: true }),
  });
}

export async function refreshFilmProjection(projectId: string): Promise<FilmProjectionPlan> {
  const response = await authFetch(filmPath(projectId, "/projection/refresh"));
  const payload = await response.json().catch(() => null) as { data?: FilmProjectionPlan; error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new FilmAPIError(response.status, payload?.error?.code ?? "projection_refresh_failed", payload?.error?.message ?? "Projection refresh failed");
  const plan = payload?.data;
  if (!plan || plan.projectId !== projectId || !Number.isSafeInteger(plan.projectionRevision) || !Array.isArray(plan.targets)) {
    throw new Error("Film projection response is invalid");
  }
  return plan;
}

export function commitFilmProjection(projectId: string, commit: FilmProjectionCommit): Promise<FilmStatus> {
  return requestFilm(projectId, "/projection/commit", { method: "POST", body: JSON.stringify(commit) });
}

export function saveFilmTimeline(projectId: string, timeline: FilmTimeline): Promise<FilmStatus> {
  return requestFilm(projectId, "/timeline", { method: "PUT", body: JSON.stringify(timeline) });
}

export function requestFilmExport(
  projectId: string,
  kind: "manifest" | "srt" | "mp4" | "asset_bundle",
  revision: number,
): Promise<FilmStatus> {
  const idempotencyKey = stableFilmIdempotencyKey("export", projectId, kind, revision);
  return requestFilm(projectId, "/exports", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ kind, revision, idempotencyKey }),
  });
}

function stableFilmIdempotencyKey(scope: string, projectId: string, discriminator: string, revision: number): string {
  const source = `${scope}:${projectId}:${discriminator}:${revision}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return `film-${scope}-${revision}-${(hash >>> 0).toString(36)}`;
}

export function restoreFilmProduction(
  projectId: string,
  document: FilmDocument,
  revision = 0,
  media: readonly FilmRestoreMedia[] = [],
): Promise<FilmStatus> {
  return requestFilm(projectId, "/restore", {
    method: "PUT",
    body: JSON.stringify({ revision, document, ...(media.length ? { media } : {}) }),
  });
}

export function filmDeliverableDownloadURL(projectId: string, deliverableId: string): string {
  return `/api/${filmPath(projectId, `/deliverables/${encodeURIComponent(deliverableId)}/download`)}`;
}
