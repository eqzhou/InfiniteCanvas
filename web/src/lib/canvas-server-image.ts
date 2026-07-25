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
): BoardProject {
  const root = project.nodes.find((node) => node.id === rootId);
  if (!root || (root.type !== "image" && root.type !== "config") || generation.count < 1 || generation.count > 8) {
    throw new Error("Server image placeholder root is invalid");
  }
  if (root.type === "image" && !root.metadata.content && !root.metadata.storageKey && generation.count === 1) {
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

  const children = Array.from({ length: generation.count }, (_, index) => createNode(
    "image",
    {
      x: root.position.x + root.width + 60 + (index % 3) * 28,
      y: root.position.y + Math.floor(index / 3) * 28,
    },
    {
      title: `结果 ${index + 1}`,
      metadata: {
        ...generation,
        status: "loading",
        generationJobId: jobId,
        generationResultIndex: index,
        batchRootId: rootId,
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
          ...generation,
          status: "loading" as const,
          errorDetails: undefined,
          generationJobId: jobId,
          isBatchRoot: true,
          batchChildIds: [...(node.metadata.batchChildIds ?? []), ...childIds],
          primaryImageId: node.metadata.primaryImageId ?? childIds[0],
          imageBatchExpanded: true,
        },
      } : node),
      ...children,
    ],
    edges: [
      ...project.edges,
      ...children.map((child) => ({ id: uid("edge"), from: rootId, to: child.id })),
    ],
  };
}
