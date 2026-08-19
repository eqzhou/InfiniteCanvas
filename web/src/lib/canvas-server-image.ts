import type { BoardProject } from "@/types/board";
import { createNode } from "@/lib/defaults";
import { uid } from "@/lib/id";
import {
  IMAGE_GENERATION_MAX_COUNT,
  imageGenerationBatchCount,
  imageGenerationSlotParameters,
} from "@/lib/image-generation-batch";
import type { createImageGenerationMetadata } from "@/lib/image-generation";
import {
  cancelServerGenerationJob,
  createServerImageGenerationJob,
  type ServerImageGenerationInput,
} from "@/services/generation-jobs";

type ImageGenerationMetadata = ReturnType<typeof createImageGenerationMetadata>;

type ServerImageGenerationStart<T> = {
  createJob: () => Promise<T>;
  applyPlaceholders: () => void;
  persist: () => Promise<void>;
  cancelJob: () => Promise<unknown>;
  onPersistError?: (error: unknown) => void;
};

/**
 * Keep recoverable canvas placeholders consistent with durable server jobs.
 * A placeholder is never exposed until the server has accepted its job id.
 */
export async function submitServerImageGeneration<T>(input: ServerImageGenerationStart<T>): Promise<T> {
  const job = await input.createJob();
  try {
    input.applyPlaceholders();
  } catch (error) {
    await input.cancelJob().catch(() => undefined);
    throw error;
  }
  try {
    await input.persist();
  } catch (error) {
    try {
      input.onPersistError?.(error);
    } catch {
      // Persistence diagnostics must never hide an already accepted job.
    }
  }
  return job;
}

function canvasImageJobIds(jobId: string | readonly string[]): string[] {
  return typeof jobId === "string" ? [jobId] : [...jobId];
}

export async function createCanvasImageGenerationSlots(
  input: Omit<ServerImageGenerationInput, "id" | "parameters"> & {
    parameters: Omit<ServerImageGenerationInput["parameters"], "count" | "requestedCount" | "batchId" | "batchIndex"> & {
      count: number;
    };
  },
): Promise<{ jobIds: string[]; jobs: Awaited<ReturnType<typeof createServerImageGenerationJob>>[] }> {
  const total = imageGenerationBatchCount(input.parameters.count);
  const jobIds = Array.from({ length: total }, () => uid("job"));
  const batchId = total > 1 ? uid("batch") : "";
  const jobs: Awaited<ReturnType<typeof createServerImageGenerationJob>>[] = [];
  try {
    for (let index = 0; index < total; index += 1) {
      const slot = imageGenerationSlotParameters({
        ...input.parameters,
        count: total,
      }, index, total, batchId);
      jobs.push(await createServerImageGenerationJob({
        ...input,
        id: jobIds[index],
        parameters: {
          ...input.parameters,
          count: 1,
          requestedCount: slot.requestedCount,
          batchId: slot.batchId || undefined,
          batchIndex: slot.batchIndex || undefined,
        },
      }));
    }
  } catch (error) {
    await Promise.allSettled(jobs.map((job) => cancelServerGenerationJob(job.id)));
    throw error;
  }
  const accepted = jobs[0];
  if (!accepted || jobs.length !== total) {
    await Promise.allSettled(jobs.map((job) => cancelServerGenerationJob(job.id)));
    throw new Error("Canvas image generation did not create the requested jobs");
  }
  return { jobIds: jobs.map((job) => job.id), jobs };
}

export function canvasGenerationJobIds(project: BoardProject, rootId: string): string[] {
  const root = project.nodes.find((node) => node.id === rootId);
  if (!root) return [];
  const outputRoot = typeof root.metadata.generationOutputRootId === "string"
    ? project.nodes.find((node) => node.id === root.metadata.generationOutputRootId)
    : undefined;
  const ids: string[] = [];
  for (const source of [root, outputRoot]) {
    if (!source) continue;
    if (source.metadata.generationJobId) ids.push(source.metadata.generationJobId);
    for (const childId of source.metadata.batchChildIds ?? []) {
      const child = project.nodes.find((node) => node.id === childId);
      if (child?.metadata.generationJobId) ids.push(child.metadata.generationJobId);
    }
  }
  return [...new Set(ids)];
}

export function canvasInFlightGenerationJobIds(project: BoardProject, rootId: string): string[] {
  return canvasGenerationJobIds(project, rootId).filter((jobId) =>
    project.nodes.some((node) => node.metadata.generationJobId === jobId && node.metadata.status === "loading"),
  );
}

export function applyServerImagePlaceholders(
  project: BoardProject,
  rootId: string,
  jobId: string | readonly string[],
  generation: ImageGenerationMetadata,
  options: { replaceExisting?: boolean } = {},
): BoardProject {
  const jobIds = canvasImageJobIds(jobId);
  const root = project.nodes.find((node) => node.id === rootId);
  if (!root || (root.type !== "image" && root.type !== "config") || generation.count < 1 || generation.count > IMAGE_GENERATION_MAX_COUNT || jobIds.length < 1) {
    throw new Error("Server image placeholder root is invalid");
  }
  const sharedJob = jobIds.length === 1;
  if (jobIds.length > 1 && jobIds.length !== generation.count) {
    throw new Error("Server image placeholder jobs do not match the requested count");
  }
  const primaryJobId = jobIds[0]!;
  if (root.type === "image" && generation.count === 1 &&
      ((!root.metadata.content && !root.metadata.storageKey) || options.replaceExisting)) {
    return {
      ...project,
      nodes: project.nodes.map((node) => node.id === rootId ? {
        ...node,
        metadata: {
          ...node.metadata,
          ...generation,
          status: "loading",
          errorDetails: undefined,
          generationJobId: primaryJobId,
          generationResultIndex: 0,
        },
      } : node),
    };
  }

  const runId = uid("run");
  const isBatch = generation.count > 1;
  const runRoot = createNode(
    "image",
    {
      x: root.position.x + root.width + 60,
      y: root.position.y,
    },
    {
      title: generation.count > 1 ? "生成结果组" : "结果 1",
      metadata: {
        ...generation,
        status: "loading",
        ...(!isBatch ? {
          generationJobId: primaryJobId,
          generationResultIndex: 0,
        } : {}),
        generationRunId: runId,
        ...(root.type === "config" ? { generationConfigId: root.id } : {}),
      },
    },
  );
  const children = Array.from({ length: isBatch ? generation.count : 0 }, (_, index) => createNode(
    "image",
    {
      x: runRoot.position.x + runRoot.width + 48 + (index % 3) * 28,
      y: runRoot.position.y + Math.floor(index / 3) * 28,
    },
    {
      title: `结果 ${index + 1}`,
      metadata: {
        ...generation,
        status: "loading",
        generationJobId: sharedJob ? primaryJobId : jobIds[index]!,
        generationResultIndex: sharedJob ? index : 0,
        generationRunId: runId,
        batchRootId: runRoot.id,
        ...(root.type === "config" ? { generationConfigId: root.id } : {}),
      },
    },
  ));
  const childIds = children.map(({ id }) => id);
  return {
    ...project,
    nodes: [
      ...project.nodes.map((node) => node.id === rootId ? {
        ...node,
        metadata: {
          ...node.metadata,
          generationOutputRootId: runRoot.id,
          ...(root.type === "config" ? {
            status: "loading" as const,
            errorDetails: undefined,
            generationJobId: primaryJobId,
          } : {}),
        },
      } : node),
      ...[
        {
          ...runRoot,
          metadata: {
            ...runRoot.metadata,
            ...(isBatch ? {
              isBatchRoot: true,
              batchChildIds: childIds,
              primaryImageId: childIds[0],
              imageBatchExpanded: true,
            } : {}),
          },
        },
        ...children,
      ],
    ],
    edges: [
      ...project.edges,
      { id: uid("edge"), from: rootId, to: runRoot.id },
      ...children.map((child) => ({ id: uid("edge"), from: runRoot.id, to: child.id })),
    ],
  };
}
