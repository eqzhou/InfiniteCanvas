import type { GenerationJob } from "@/types/board";
import {
  createServerImageGenerationJob,
  cancelServerGenerationJob,
  waitForGenerationJob,
  type ServerImageGenerationInput,
} from "@/services/generation-jobs";
import { getBlob } from "@/services/storage";
import {
  MAX_PANORAMA_BATCH_BYTES,
  MAX_PANORAMA_BATCH_PIXELS,
  isSupportedPanoramaMimeType,
  readPanoramaBlobDimensions,
  validatePanoramaDimensions,
} from "@/lib/panorama";
import type { PanoramaGeneratedMedia } from "@/lib/panorama-generation";

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
  retryAfterFailure?: (attempt: number, signal?: AbortSignal) => Promise<void>;
};

export type PanoramaServerGenerationInput = {
  projectId: string;
  prompt: string;
  providerId: string;
  model: string;
  size: string;
  quality: string;
  count: number;
  referenceStorageKeys: string[];
  signal?: AbortSignal;
  onCreated?: (job: GenerationJob) => void | Promise<void>;
};

type PanoramaServerGenerationResult = {
  jobId: string;
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
  if (values.length !== expectedCount || expectedCount < 1 || expectedCount > 8) {
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
  const job = await dependencies.createJob({
    projectId: input.projectId,
    prompt: input.prompt,
    providerId: input.providerId,
    model: input.model,
    parameters: {
      size: input.size,
      quality: input.quality,
      count: input.count,
      category: "panorama",
      referenceStorageKeys: [...input.referenceStorageKeys],
    },
  });
  assertPanoramaJobScope(job, { jobId: job.id, projectId: input.projectId });
  try {
    await input.onCreated?.(job);
  } catch (error) {
    await dependencies.cancelJob?.(job.id).catch(() => undefined);
    throw error;
  }
  const completed = await waitForDurablePanoramaJob(job.id, input.signal, dependencies);
  const media = await loadPanoramaServerResults(completed, input.count, dependencies, {
    jobId: job.id,
    projectId: input.projectId,
  });
  return { jobId: job.id, media };
}

export async function resumePanoramaServerGeneration(
  jobId: string,
  projectId: string,
  expectedCount: number,
  signal?: AbortSignal,
  dependencies: PanoramaResumeDependencies = defaultDependencies,
): Promise<PanoramaGeneratedMedia[]> {
  const completed = await waitForDurablePanoramaJob(jobId, signal, dependencies);
  return loadPanoramaServerResults(completed, expectedCount, dependencies, { jobId, projectId });
}
