import type { GenerationJob } from "@/types/board";
import {
  createServerImageGenerationJob,
  cancelServerGenerationJob,
  waitForGenerationJob,
  type ServerImageGenerationInput,
} from "@/services/generation-jobs";
import { getBlob } from "@/services/storage";
import {
  imageGenerationBatchCount,
  imageGenerationSlotParameters,
} from "@/lib/image-generation-batch";
import { uid } from "@/lib/id";
import {
  MAX_PANORAMA_BATCH_BYTES,
  MAX_PANORAMA_BATCH_PIXELS,
  isSupportedPanoramaMimeType,
  readPanoramaBlobDimensions,
  validatePanoramaDimensions,
} from "@/lib/panorama";
import { PANORAMA_MAX_RESULTS, type PanoramaGeneratedMedia } from "@/lib/panorama-generation";

type PanoramaResultDependencies = {
  readBlob: (storageKey: string) => Promise<Blob | undefined>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

type PanoramaServerDependencies = PanoramaResultDependencies & {
  createJob: (input: ServerImageGenerationInput) => Promise<GenerationJob>;
  waitForJob: (id: string, signal?: AbortSignal) => Promise<GenerationJob>;
  cancelJob?: (id: string) => Promise<GenerationJob>;
  retryAfterFailure?: (attempt: number, signal?: AbortSignal) => Promise<void>;
};

type PanoramaResumeDependencies = PanoramaResultDependencies & {
  waitForJob: (id: string, signal?: AbortSignal) => Promise<GenerationJob>;
  cancelJob?: (id: string) => Promise<GenerationJob>;
  retryAfterFailure?: (attempt: number, signal?: AbortSignal) => Promise<void>;
};

export type PanoramaServerGenerationInput = {
  projectId: string;
  prompt: string;
  providerId: string;
  model: string;
  size: string;
  quality: string;
  resolution?: string;
  count: number;
  referenceStorageKeys: string[];
  signal?: AbortSignal;
  onCreated?: (job: GenerationJob, jobs: GenerationJob[]) => void | Promise<void>;
};

type PanoramaServerGenerationResult = {
  jobId: string;
  jobIds: string[];
  media: PanoramaGeneratedMedia[];
};

type PanoramaJobScope = {
  jobId: string;
  projectId: string;
};

function assertPanoramaJobScope(job: GenerationJob, scope: PanoramaJobScope): void {
  if (job.id !== scope.jobId || job.projectId !== scope.projectId || job.kind !== "image" ||
      job.parameters.executor !== "server" || job.parameters.category !== "panorama") {
    throw new Error("全景生成任务与当前项目不匹配");
  }
}

function serverResultItems(job: GenerationJob, expectedCount: number, scope: PanoramaJobScope): Array<{
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}> {
  assertPanoramaJobScope(job, scope);
  if (job.status === "failed") throw new Error(job.error || "图片生成失败，请检查模型服务配置后重试");
  if (job.status === "cancelled" || job.status === "deleted") throw new Error("全景图生成已取消");
  if (job.status !== "succeeded") throw new Error("全景生成任务尚未完成");
  const values = Array.isArray(job.result.items) ? job.result.items : [];
  if (values.length !== expectedCount || expectedCount < 1 || expectedCount > PANORAMA_MAX_RESULTS) {
    throw new Error(`生成服务应返回 ${expectedCount} 张全景图片，实际返回 ${values.length} 张`);
  }
  let totalBytes = 0;
  let totalPixels = 0;
  const items = values.map((value) => {
    if (!value || typeof value !== "object") throw new Error("全景生成结果信息无效");
    const item = value as Record<string, unknown>;
    if (typeof item.storageKey !== "string" || item.storageKey.length < 1 || item.storageKey.length > 512 ||
        typeof item.mimeType !== "string" || !isSupportedPanoramaMimeType(item.mimeType) ||
        typeof item.width !== "number" || !Number.isSafeInteger(item.width) || item.width < 1 ||
        typeof item.height !== "number" || !Number.isSafeInteger(item.height) || item.height < 1 ||
        typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 1) {
      throw new Error("全景生成结果信息无效");
    }
    validatePanoramaDimensions(item.width, item.height);
    if (item.bytes > MAX_PANORAMA_BATCH_BYTES) {
      throw new Error("全景生成批次超出 64 MB 或 6400 万像素限制");
    }
    totalBytes += item.bytes;
    totalPixels += item.width * item.height;
    if (totalBytes > MAX_PANORAMA_BATCH_BYTES || totalPixels > MAX_PANORAMA_BATCH_PIXELS) {
      throw new Error("全景生成批次超出 64 MB 或 6400 万像素限制");
    }
    return {
      storageKey: item.storageKey,
      mimeType: item.mimeType,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
    };
  });
  if (new Set(items.map((item) => item.storageKey)).size !== items.length) {
    throw new Error("全景生成结果包含重复媒体");
  }
  return items;
}

export async function loadPanoramaServerResults(
  job: GenerationJob,
  expectedCount: number,
  dependencies: PanoramaResultDependencies = {
    readBlob: (storageKey) => getBlob("image", storageKey),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  },
  scope: PanoramaJobScope = { jobId: job.id, projectId: job.projectId ?? "" },
): Promise<PanoramaGeneratedMedia[]> {
  const items = serverResultItems(job, expectedCount, scope);
  const createdURLs: string[] = [];
  try {
    const media: PanoramaGeneratedMedia[] = [];
    for (const item of items) {
      const blob = await dependencies.readBlob(item.storageKey);
      if (!blob || blob.size !== item.bytes || blob.type !== item.mimeType) {
        throw new Error("全景生成结果已丢失或内容不一致");
      }
      const dimensions = await readPanoramaBlobDimensions(blob);
      if (dimensions.width !== item.width || dimensions.height !== item.height) {
        throw new Error("全景生成结果尺寸信息不一致");
      }
      const content = dependencies.createObjectURL(blob);
      createdURLs.push(content);
      media.push({
        content,
        storageKey: item.storageKey,
        naturalWidth: dimensions.width,
        naturalHeight: dimensions.height,
        bytes: item.bytes,
        mimeType: item.mimeType,
      });
    }
    return media;
  } catch (error) {
    createdURLs.forEach((url) => dependencies.revokeObjectURL?.(url));
    throw error;
  }
}

const defaultDependencies: PanoramaServerDependencies = {
  createJob: createServerImageGenerationJob,
  waitForJob: (id, signal) => waitForGenerationJob(id, { signal }),
  cancelJob: cancelServerGenerationJob,
  readBlob: (storageKey) => getBlob("image", storageKey),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const exponentialDelay = Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
    const jitteredDelay = Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
    const timer = globalThis.setTimeout(complete, jitteredDelay);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isPermanentPollingFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.message === "invalid generation job id" || error.message === "generation job not found";
}

async function waitForDurablePanoramaJob(
  jobId: string,
  signal: AbortSignal | undefined,
  dependencies: PanoramaResumeDependencies,
): Promise<GenerationJob> {
  let attempt = 0;
  for (;;) {
    try {
      return await dependencies.waitForJob(jobId, signal);
    } catch (error) {
      if (signal?.aborted || isPermanentPollingFailure(error)) throw error;
      attempt += 1;
      await (dependencies.retryAfterFailure ?? retryDelay)(attempt, signal);
    }
  }
}

export async function runPanoramaServerGeneration(
  input: PanoramaServerGenerationInput,
  dependencies: PanoramaServerDependencies = defaultDependencies,
): Promise<PanoramaServerGenerationResult> {
  const total = imageGenerationBatchCount(input.count, PANORAMA_MAX_RESULTS);
  const batchId = total > 1 ? uid("batch") : "";
  const jobs: GenerationJob[] = [];
  try {
    for (let index = 0; index < total; index += 1) {
      const slot = imageGenerationSlotParameters({
        size: input.size,
        quality: input.quality,
        ...(input.resolution ? { resolution: input.resolution } : {}),
        count: total,
        category: "panorama",
        referenceStorageKeys: [...input.referenceStorageKeys],
      }, index, total, batchId);
      const job = await dependencies.createJob({
        projectId: input.projectId,
        prompt: input.prompt,
        providerId: input.providerId,
        model: input.model,
        parameters: {
          size: slot.size,
          quality: slot.quality,
          ...(slot.resolution ? { resolution: slot.resolution } : {}),
          count: 1,
          requestedCount: slot.requestedCount,
          batchId: slot.batchId || undefined,
          batchIndex: slot.batchIndex || undefined,
          category: "panorama",
          referenceStorageKeys: [...input.referenceStorageKeys],
        },
      });
      assertPanoramaJobScope(job, { jobId: job.id, projectId: input.projectId });
      jobs.push(job);
    }
  } catch (error) {
    await Promise.allSettled(jobs.map((job) => dependencies.cancelJob?.(job.id) ?? Promise.resolve()));
    throw error;
  }
  const primary = jobs[0];
  if (!primary) throw new Error("全景生成任务未创建");
  try {
    await input.onCreated?.(primary, jobs);
  } catch (error) {
    await Promise.allSettled(jobs.map((job) => dependencies.cancelJob?.(job.id) ?? Promise.resolve()));
    throw error;
  }
  const media = await loadPanoramaJobs(jobs.map((job) => job.id), input.projectId, total, input.signal, dependencies);
  return { jobId: primary.id, jobIds: jobs.map((job) => job.id), media };
}

export async function resumePanoramaServerGeneration(
  jobId: string,
  projectId: string,
  expectedCount: number,
  signal?: AbortSignal,
  dependencies: PanoramaResumeDependencies = defaultDependencies,
  extraJobIds?: readonly string[],
): Promise<PanoramaGeneratedMedia[]> {
  const jobIds = extraJobIds?.length ? [...extraJobIds] : [jobId];
  return loadPanoramaJobs(jobIds, projectId, expectedCount, signal, dependencies);
}

async function loadPanoramaJobs(
  jobIds: string[],
  projectId: string,
  expectedCount: number,
  signal: AbortSignal | undefined,
  dependencies: PanoramaResumeDependencies,
): Promise<PanoramaGeneratedMedia[]> {
  const uniqueIds = [...new Set(jobIds.filter(Boolean))];
  if (uniqueIds.length === 1) {
    const completed = await waitForDurablePanoramaJob(uniqueIds[0]!, signal, dependencies);
    return loadPanoramaServerResults(completed, expectedCount, dependencies, { jobId: completed.id, projectId });
  }
  if (uniqueIds.length !== expectedCount) {
    throw new Error(`生成服务应返回 ${expectedCount} 张全景图片，实际返回 ${uniqueIds.length} 张`);
  }
  try {
    const completed = await Promise.all(uniqueIds.map(async (id) => {
      const job = await waitForDurablePanoramaJob(id, signal, dependencies);
      if (job.status !== "succeeded") {
        if (job.status === "failed") throw new Error(job.error || "图片生成失败，请检查模型服务配置后重试");
        if (job.status === "cancelled" || job.status === "deleted") throw new Error("全景图生成已取消");
        throw new Error("全景生成任务尚未完成");
      }
      return job;
    }));
    const media: PanoramaGeneratedMedia[] = [];
    const createdURLs: string[] = [];
    try {
      for (const job of completed) {
        const items = await loadPanoramaServerResults(job, 1, dependencies, { jobId: job.id, projectId });
        createdURLs.push(...items.map((item) => item.content));
        media.push(...items);
      }
      return media;
    } catch (error) {
      createdURLs.forEach((url) => dependencies.revokeObjectURL?.(url));
      throw error;
    }
  } catch (error) {
    if (!signal?.aborted) {
      await Promise.allSettled(uniqueIds.map((id) => dependencies.cancelJob?.(id) ?? Promise.resolve()));
    }
    throw error;
  }
}
