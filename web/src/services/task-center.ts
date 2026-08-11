import type { GenerationJob, GenerationKind, GenerationStatus } from "@/types/board";

export type TaskCenterSource = "film" | "image-workbench" | "video-workbench" | "workflow" | "canvas";
export type TaskCenterItem = {
  id: string;
  projectId?: string;
  kind: GenerationKind;
  status: GenerationStatus;
  source: TaskCenterSource;
  stage?: string;
  shotId?: string;
  parentTaskId?: string;
  title: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  sourcePath: string;
  progress?: number;
  total?: number;
  succeeded?: number;
  failed?: number;
};

export type TaskCenterFilters = { status?: GenerationStatus | ""; kind?: GenerationKind | ""; projectId?: string };

function boundedString(value: unknown, max = 128): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function filmBinding(parameters: Record<string, unknown>): { stage?: string; shotId?: string; parentTaskId?: string } | null {
  const value = parameters.film;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const stage = boundedString(item.stage);
  if (!stage) return null;
  return { stage, shotId: boundedString(item.shotId), parentTaskId: boundedString(item.parentGenerationJobId ?? item.parentTaskId ?? item.taskId) };
}

function stageParentBinding(job: GenerationJob): { stage?: string; childJobIds: string[] } | null {
  if (job.kind !== "film-stage") return null;
  const stage = boundedString(job.parameters.stage);
  const childJobIds = Array.isArray(job.parameters.childJobIds)
    ? job.parameters.childJobIds.slice(0, 1_000).map((value) => boundedString(value)).filter((value): value is string => Boolean(value))
    : [];
  return { stage, childJobIds };
}

function boundedCount(value: unknown, maximum = 1_000_000): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : undefined;
}

function filmProgress(job: GenerationJob): Pick<TaskCenterItem, "progress" | "total" | "succeeded" | "failed"> {
  if (job.kind !== "film-stage") return {};
  const progress = typeof job.result.progress === "number" && Number.isFinite(job.result.progress) ? Math.max(0, Math.min(1, job.result.progress)) : undefined;
  const total = boundedCount(job.result.total);
  const succeeded = boundedCount(job.result.succeeded, total);
  const failed = boundedCount(job.result.failed, total);
  return { ...(progress !== undefined ? { progress } : {}), ...(total !== undefined ? { total } : {}), ...(succeeded !== undefined ? { succeeded } : {}), ...(failed !== undefined ? { failed } : {}) };
}

function aggregateStageStatus(children: readonly GenerationJob[], fallback: GenerationStatus): GenerationStatus {
  if (!children.length) return fallback;
  if (children.some((child) => child.status === "running")) return "running";
  if (children.some((child) => child.status === "queued")) return "queued";
  if (children.some((child) => child.status === "failed")) return "failed";
  if (children.every((child) => child.status === "cancelled" || child.status === "deleted")) return "cancelled";
  if (children.every((child) => child.status === "succeeded")) return "succeeded";
  return fallback;
}

function kindLabel(kind: GenerationKind): string {
  return { text: "文本", image: "图片", video: "视频", audio: "音频", workflow: "工作流", export: "导出", "film-stage": "影视阶段" }[kind];
}

export function buildTaskCenterItems(jobs: readonly GenerationJob[]): TaskCenterItem[] {
  const effectiveJobs = jobs.map((job) => {
    const parent = stageParentBinding(job);
    if (!parent) return job;
    if (job.status === "cancelled" || job.status === "deleted") return job;
    const childIds = new Set(parent.childJobIds);
    const children = jobs.filter((candidate) => childIds.has(candidate.id) || filmBinding(candidate.parameters)?.parentTaskId === job.id);
    const updatedAt = children.reduce((latest, child) => child.updatedAt > latest ? child.updatedAt : latest, job.updatedAt);
    return { ...job, status: aggregateStageStatus(children, job.status), updatedAt };
  });
  const items = effectiveJobs.map((job) => {
    const parent = stageParentBinding(job);
    const film = filmBinding(job.parameters) ?? (parent?.stage ? { stage: parent.stage } : null);
    const source: TaskCenterSource = film || job.kind === "export" || job.kind === "film-stage" ? "film" : job.kind === "image" ? "image-workbench" : job.kind === "video" ? "video-workbench" : job.kind === "workflow" ? "workflow" : "canvas";
    const sourcePath = source === "film" && job.projectId ? `/film/${encodeURIComponent(job.projectId)}` : source === "image-workbench" ? "/workbench/image" : source === "video-workbench" ? "/workbench/video" : source === "workflow" ? "/workbench/workflows" : "/";
    const title = film?.shotId ? `${kindLabel(job.kind)} · 镜头 ${film.shotId}` : film?.stage ? `${kindLabel(job.kind)} · ${film.stage}` : `${kindLabel(job.kind)}任务`;
    return {
      id: job.id, ...(job.projectId ? { projectId: job.projectId } : {}), kind: job.kind, status: job.status,
      source, ...(film?.stage ? { stage: film.stage } : {}), ...(film?.shotId ? { shotId: film.shotId } : {}),
      ...(film?.parentTaskId ? { parentTaskId: film.parentTaskId } : {}), title,
      ...(job.error ? { error: job.error.slice(0, 500) } : {}), ...filmProgress(job), createdAt: job.createdAt, updatedAt: job.updatedAt, sourcePath,
    };
  });
  const byID = new Map(items.map((item) => [item.id, item]));
  return items.sort((left, right) => {
    if (left.parentTaskId === right.id) return 1;
    if (right.parentTaskId === left.id) return -1;
    const leftRoot = left.parentTaskId && byID.has(left.parentTaskId) ? left.parentTaskId : left.id;
    const rightRoot = right.parentTaskId && byID.has(right.parentTaskId) ? right.parentTaskId : right.id;
    if (leftRoot === rightRoot) return left.id.localeCompare(right.id);
    return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
  });
}

export function filterTaskCenterItems(items: readonly TaskCenterItem[], filters: TaskCenterFilters): TaskCenterItem[] {
  return items.filter((item) => (!filters.status || item.status === filters.status) && (!filters.kind || item.kind === filters.kind) && (!filters.projectId || item.projectId === filters.projectId)).map((item) => ({ ...item }));
}
