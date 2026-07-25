import { useEffect, useMemo } from "react";
import type { GenerationJob, NodeMetadata } from "@/types/board";
import { getGenerationJob, usesServerGenerationJobs } from "@/services/generation-jobs";
import { getBlob } from "@/services/storage";
import { useBoardStore } from "@/stores/use-board-store";

type GenerationResultItem = {
  storageKey: string;
  mimeType?: string;
  bytes?: number;
  width?: number;
  height?: number;
};

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

export function useCanvasGenerationRecovery(): void {
  const project = useBoardStore((state) => state.getActive());
  const updateNode = useBoardStore((state) => state.updateNode);
  const pending = useMemo(() => (project?.nodes ?? [])
    .filter((node) => (node.type === "image" || node.type === "video" || node.type === "audio") &&
      !node.metadata.isBatchRoot && node.metadata.status === "loading" && node.metadata.generationJobId)
    .slice(0, 32)
    .map((node) => ({
      nodeId: node.id,
      jobId: node.metadata.generationJobId!,
      resultIndex: node.metadata.generationResultIndex ?? 0,
    })), [project?.nodes]);

  useEffect(() => {
    if (!usesServerGenerationJobs() || pending.length === 0) return;
    let disposed = false;
    const inFlight = new Set<string>();
    const groups = new Map<string, typeof pending>();
    for (const target of pending) groups.set(target.jobId, [...(groups.get(target.jobId) ?? []), target]);
    const reconcile = async () => {
      await Promise.all([...groups].map(async ([jobId, targets]) => {
        if (inFlight.has(jobId)) return;
        inFlight.add(jobId);
        try {
          const job = await getGenerationJob(jobId);
          if (disposed || !job || job.status === "queued" || job.status === "running") return;
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
            const blob = await getBlob(item.storageKey.startsWith("image:") ? "image" : "media", item.storageKey);
            if (disposed) return;
            updateNode(nodeId, { metadata: canvasGenerationPatch(job, blob ? URL.createObjectURL(blob) : undefined, resultIndex) });
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
  }, [pending, updateNode]);

  useEffect(() => {
    for (const root of project?.nodes ?? []) {
      if (root.metadata.status !== "loading" || !root.metadata.batchChildIds?.length) continue;
      const children = root.metadata.batchChildIds
        .map((id) => project?.nodes.find((node) => node.id === id))
        .filter((node): node is NonNullable<typeof node> => Boolean(node));
      if (children.length !== root.metadata.batchChildIds.length || children.some((child) => child.metadata.status === "loading")) {
        continue;
      }
      const failed = children.find((child) => child.metadata.status === "error");
      updateNode(root.id, { metadata: {
        status: failed ? "error" : "success",
        errorDetails: failed?.metadata.errorDetails,
      } });
    }
  }, [project?.nodes, updateNode]);
}
