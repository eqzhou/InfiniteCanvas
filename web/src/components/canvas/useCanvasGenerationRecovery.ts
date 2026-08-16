import { useEffect, useMemo } from "react";
import type { GenerationJob, NodeMetadata } from "@/types/board";
import { getGenerationJob, usesServerGenerationJobs } from "@/services/generation-jobs";
import { getBlob } from "@/services/storage";
import { createServerBlobDisplayUrls } from "@/services/server-storage";
import { useBoardStore } from "@/stores/use-board-store";

type GenerationResultItem = {
  storageKey: string;
  mimeType?: string;
  bytes?: number;
  width?: number;
  height?: number;
};

const MISSING_JOB_GRACE_MS = 30_000;

function resultItem(job: GenerationJob, index = 0): GenerationResultItem | undefined {
  const items = Array.isArray(job.result.items) ? job.result.items : [];
  if (items.length > 8) return undefined;
  const value = items[index];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.storageKey !== "string" || candidate.storageKey.length < 1 || candidate.storageKey.length > 512) {
    return undefined;
  }
  return {
    storageKey: candidate.storageKey,
    mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined,
    bytes: typeof candidate.bytes === "number" && Number.isSafeInteger(candidate.bytes) && candidate.bytes >= 0
      ? candidate.bytes
      : undefined,
    width: typeof candidate.width === "number" && Number.isSafeInteger(candidate.width) && candidate.width > 0
      ? candidate.width
      : undefined,
    height: typeof candidate.height === "number" && Number.isSafeInteger(candidate.height) && candidate.height > 0
      ? candidate.height
      : undefined,
  };
}

export function canvasGenerationPatch(job: GenerationJob, content?: string, resultIndex = 0): Partial<NodeMetadata> {
  if (job.status === "failed" || job.status === "cancelled") {
    return {
      status: "error",
      errorDetails: job.error || (job.status === "cancelled" ? "已取消" : "生成失败，请重试"),
      generationJobId: job.id,
    };
  }
  const item = resultItem(job, resultIndex);
  if (job.status !== "succeeded" || !item || !content) {
    return {
      status: "error",
      errorDetails: "生成任务缺少可恢复的媒体结果",
      generationJobId: job.id,
    };
  }
  return {
    content,
    storageKey: item.storageKey,
    mimeType: item.mimeType,
    bytes: item.bytes,
    ...(item.width ? { naturalWidth: item.width } : {}),
    ...(item.height ? { naturalHeight: item.height } : {}),
    status: "success",
    errorDetails: undefined,
    generationJobId: job.id,
  };
}

export function batchPreviewPatch(
  children: ReadonlyArray<Pick<NodeMetadata,
    "status" | "errorDetails" | "content" | "storageKey" | "mimeType" | "bytes" |
    "naturalWidth" | "naturalHeight">>,
): Partial<NodeMetadata> | undefined {
  if (children.length === 0 || children.some((child) => child.status === "loading")) return undefined;
  const successful = children.find((child) =>
    child.status === "success" && Boolean(child.content || child.storageKey));
  if (!successful) {
    return {
      status: "error",
      errorDetails: children.find((child) => child.errorDetails)?.errorDetails || "全部图片生成失败",
    };
  }
  return {
    content: successful.content,
    storageKey: successful.storageKey,
    mimeType: successful.mimeType,
    bytes: successful.bytes,
    naturalWidth: successful.naturalWidth,
    naturalHeight: successful.naturalHeight,
    status: "success",
    errorDetails: undefined,
  };
}

export function generationRunPatch(
  root: Pick<NodeMetadata, "status" | "errorDetails">,
  children: ReadonlyArray<Pick<NodeMetadata,
    "status" | "errorDetails" | "content" | "storageKey" | "mimeType" | "bytes" |
    "naturalWidth" | "naturalHeight">>,
): Partial<NodeMetadata> | undefined {
  if (children.length > 0) return batchPreviewPatch(children);
  if (root.status === "loading") return undefined;
  if (root.status === "success") return { status: "success", errorDetails: undefined };
  if (root.status === "error") return { status: "error", errorDetails: root.errorDetails };
  return undefined;
}

export function missingGenerationPatch(
  firstMissingAt: number,
  now: number,
): Partial<NodeMetadata> | undefined {
  if (now - firstMissingAt < MISSING_JOB_GRACE_MS) return undefined;
  return {
    status: "error",
    errorDetails: "生成任务未成功提交，请重试",
  };
}

export function useCanvasGenerationRecovery(): void {
  const project = useBoardStore((state) => state.getActive());
  const updateNode = useBoardStore((state) => state.updateNode);
  const mediaLoads = useMemo(() => new Map<string, Promise<string | undefined>>(), []);
  const pending = useMemo(() => (project?.nodes ?? [])
    .filter((node) => (node.type === "image" || node.type === "video" || node.type === "audio") &&
      node.metadata.status === "loading" && node.metadata.generationJobId)
    .slice(0, 32)
    .map((node) => ({
      nodeId: node.id,
      jobId: node.metadata.generationJobId!,
      resultIndex: node.metadata.generationResultIndex ?? 0,
    })), [project?.nodes]);
  const pendingKey = pending.map(({ nodeId, jobId, resultIndex }) =>
    `${nodeId}:${jobId}:${resultIndex}`).join("|");

  const loadMediaUrl = (storageKey: string): Promise<string | undefined> => {
    const existing = mediaLoads.get(storageKey);
    if (existing) return existing;
    const promise = createServerBlobDisplayUrls([storageKey]).catch(() => new Map()).then((displayUrls) => {
      const displayUrl = displayUrls.get(storageKey);
      if (displayUrl) return displayUrl;
      return getBlob(storageKey.startsWith("image:") ? "image" : "media", storageKey)
        .then((blob) => blob ? URL.createObjectURL(blob) : undefined);
    }).then(
      (value) => {
        if (mediaLoads.get(storageKey) === promise) mediaLoads.delete(storageKey);
        return value;
      },
      (error: unknown) => {
        if (mediaLoads.get(storageKey) === promise) mediaLoads.delete(storageKey);
        throw error;
      },
    );
    mediaLoads.set(storageKey, promise);
    return promise;
  };

  useEffect(() => {
    if (!usesServerGenerationJobs() || pending.length === 0) return;
    let disposed = false;
    const inFlight = new Set<string>();
    const missingSince = new Map<string, number>();
    const groups = new Map<string, typeof pending>();
    for (const target of pending) groups.set(target.jobId, [...(groups.get(target.jobId) ?? []), target]);
    const reconcile = async () => {
      await Promise.all([...groups].map(async ([jobId, targets]) => {
        if (inFlight.has(jobId)) return;
        inFlight.add(jobId);
        try {
          const job = await getGenerationJob(jobId);
          if (disposed) return;
          if (!job) {
            const firstMissingAt = missingSince.get(jobId) ?? Date.now();
            missingSince.set(jobId, firstMissingAt);
            const patch = missingGenerationPatch(firstMissingAt, Date.now());
            if (patch) {
              targets.forEach(({ nodeId }) => updateNode(nodeId, { metadata: patch }));
            }
            return;
          }
          missingSince.delete(jobId);
          if (job.status === "queued" || job.status === "running") return;
          await Promise.all(targets.map(async ({ nodeId, resultIndex }) => {
            if (job.status !== "succeeded") {
              updateNode(nodeId, { metadata: canvasGenerationPatch(job, undefined, resultIndex) });
              return;
            }
            const item = resultItem(job, resultIndex);
            if (!item) {
              updateNode(nodeId, { metadata: canvasGenerationPatch(job, undefined, resultIndex) });
              return;
            }
            const content = await loadMediaUrl(item.storageKey);
            if (disposed) return;
            updateNode(nodeId, { metadata: canvasGenerationPatch(job, content, resultIndex) });
          }));
        } catch {
          // A transient API/media read failure remains loading and is retried.
        } finally {
          inFlight.delete(jobId);
        }
      }));
    };
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pendingKey, updateNode]);

  useEffect(() => {
    const nodes = project?.nodes ?? [];
    for (const root of nodes) {
      if (root.type !== "image" || root.metadata.batchRootId ||
          (!root.metadata.batchChildIds?.length && !root.metadata.generationConfigId)) continue;
      const children = (root.metadata.batchChildIds ?? [])
        .map((id) => nodes.find((node) => node.id === id))
        .filter((node): node is NonNullable<typeof node> => Boolean(node));
      if (children.length !== (root.metadata.batchChildIds?.length ?? 0)) continue;
      const patch = generationRunPatch(root.metadata, children.map((child) => child.metadata));
      if (!patch) continue;
      if (children.length > 0 && (root.metadata.status !== patch.status ||
          root.metadata.errorDetails !== patch.errorDetails ||
          root.metadata.storageKey !== patch.storageKey || root.metadata.content !== patch.content)) {
        updateNode(root.id, { metadata: patch });
      }
      const config = nodes.find((node) => node.id === root.metadata.generationConfigId);
      if (config?.type === "config" && config.metadata.generationOutputRootId === root.id &&
          (config.metadata.status !== patch.status || config.metadata.errorDetails !== patch.errorDetails)) {
        updateNode(config.id, { metadata: { status: patch.status, errorDetails: patch.errorDetails } });
      }
    }
  }, [project?.nodes, updateNode]);
}
