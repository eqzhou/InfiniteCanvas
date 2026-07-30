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
          status: "loading",
          errorDetails: undefined,
          generationJobId: jobId,
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
          generationJobId: jobId,
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
        generationJobId: jobId,
        generationResultIndex: index,
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
