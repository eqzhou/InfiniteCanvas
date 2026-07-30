import type { BoardProject } from "@/types/board";
import { createNode } from "@/lib/defaults";
import { uid } from "@/lib/id";
import type { createImageGenerationMetadata } from "@/lib/image-generation";

type ImageGenerationMetadata = ReturnType<typeof createImageGenerationMetadata>;

export function applyServerImagePlaceholders(
  project: BoardProject,
  rootId: string,
  jobId: string,
  generation: ImageGenerationMetadata,
  options: { replaceExisting?: boolean } = {},
): BoardProject {
  const root = project.nodes.find((node) => node.id === rootId);
  if (!root || (root.type !== "image" && root.type !== "config") || generation.count < 1 || generation.count > 8) {
    throw new Error("Server image placeholder root is invalid");
  }
  if (root.type === "image" && generation.count === 1 &&
      ((!root.metadata.content && !root.metadata.storageKey) || options.replaceExisting)) {
    return {
      ...project,
      nodes: project.nodes.map((node) => node.id === rootId ? {
        ...node,
        metadata: {
          ...node.metadata,
          ...generation,
          requestPrompt: generation.requestPrompt ?? generation.prompt,
          status: "loading",
          errorDetails: undefined,
          generationJobId: jobId,
          generationResultIndex: 0,
        },
      } : node),
    };
  }

  const runId = uid("run");
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
        requestPrompt: generation.requestPrompt ?? generation.prompt,
        status: "loading",
        generationJobId: jobId,
        generationResultIndex: 0,
        generationRunId: runId,
        ...(root.type === "config" ? { generationConfigId: root.id } : {}),
      },
    },
  );
  const children = Array.from({ length: generation.count - 1 }, (_, offset) => createNode(
    "image",
    {
      x: runRoot.position.x + runRoot.width + 48 + (offset % 3) * 28,
      y: runRoot.position.y + Math.floor(offset / 3) * 28,
    },
    {
      title: `结果 ${offset + 2}`,
      metadata: {
        ...generation,
        requestPrompt: generation.requestPrompt ?? generation.prompt,
        status: "loading",
        generationJobId: jobId,
        generationResultIndex: offset + 1,
        generationRunId: runId,
        batchRootId: runRoot.id,
        ...(root.type === "config" ? { generationConfigId: root.id } : {}),
      },
    },
  ));
  const childIds = children.map(({ id }) => id);
  const isBatch = children.length > 0;
  return {
    ...project,
    nodes: [
      ...project.nodes.map((node) => node.id === rootId ? {
        ...node,
        metadata: {
          ...node.metadata,
          ...(root.type === "config" ? {
            status: "loading" as const,
            errorDetails: undefined,
            generationJobId: jobId,
            generationOutputRootId: runRoot.id,
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
              primaryImageId: runRoot.id,
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
