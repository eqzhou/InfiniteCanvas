import type { BoardNode, BoardProject, NodeMetadata } from "@/types/board";
import { uid } from "@/lib/id";

type PlaceImageGenerationRunOptions = {
  sourceId: string;
  results: readonly BoardNode[];
  /** A fresh empty image is an intentional output target, not a source image. */
  reuseEmptyImageTarget?: boolean;
  sourceMetadata?: Partial<NodeMetadata>;
};

/**
 * Put one image-generation invocation on the canvas.
 *
 * A config node is never a batch root. Each invocation gets an image result
 * root so running the same config again cannot merge, overwrite, or hide a
 * previous run. An empty image node is the only reusable output target.
 */
export function placeImageGenerationRun(
  project: BoardProject,
  { sourceId, results, reuseEmptyImageTarget = false, sourceMetadata = {} }: PlaceImageGenerationRunOptions,
): BoardProject {
  const source = project.nodes.find((node) => node.id === sourceId);
  if (!source || results.length < 1) throw new Error("Image generation run is missing its source or results");

  const [firstResult] = results;
  const runId = firstResult.metadata.generationRunId ?? uid("run");
  const isReusableEmptyImage = reuseEmptyImageTarget && source.type === "image" &&
    !source.metadata.content && !source.metadata.storageKey;
  const isBatch = results.length > 1;
  const batchRootId = isReusableEmptyImage ? source.id : isBatch ? uid("image") : firstResult.id;
  const childResults = isBatch ? [...results] : [];
  const childIds = childResults.map((node) => node.id);
  const sourceConfig = source.type === "config" ? source.id : undefined;
  const runMetadata = (metadata: NodeMetadata, isRoot = false): NodeMetadata => ({
    ...metadata,
    generationRunId: metadata.generationRunId ?? runId,
    ...(sourceConfig ? { generationConfigId: sourceConfig } : {}),
    ...(isRoot && childIds.length > 0 ? {
      isBatchRoot: true,
      batchChildIds: childIds,
      primaryImageId: childIds[0],
      imageBatchExpanded: true,
    } : {}),
  });
  const normalizedChildren = childResults.map((result) => ({
    ...result,
    metadata: {
      ...runMetadata(result.metadata),
      batchRootId,
      isBatchRoot: undefined,
      batchChildIds: undefined,
    },
  }));
  const outputRoot = isReusableEmptyImage
    ? {
        ...source,
        width: firstResult.width,
        height: firstResult.height,
        metadata: {
          ...source.metadata,
          ...runMetadata(firstResult.metadata, true),
          ...sourceMetadata,
        },
      }
    : isBatch
      ? {
          ...firstResult,
          id: batchRootId,
          title: "生成结果组",
          metadata: runMetadata(firstResult.metadata, true),
        }
      : {
          ...firstResult,
          metadata: runMetadata(firstResult.metadata),
        };

  return {
    ...project,
    nodes: [
      ...project.nodes.map((node) => {
        if (node.id === sourceId && isReusableEmptyImage) return outputRoot;
        if (node.id !== sourceId) return node;
        return {
          ...node,
          metadata: {
            ...node.metadata,
            status: "success" as const,
            errorDetails: undefined,
            ...(source.type === "config" ? { generationOutputRootId: outputRoot.id } : {}),
            ...sourceMetadata,
          },
        };
      }),
      ...(isReusableEmptyImage ? [] : [outputRoot]),
      ...normalizedChildren,
    ],
    edges: [
      ...project.edges,
      ...(isReusableEmptyImage ? [] : [{ id: uid("edge"), from: sourceId, to: outputRoot.id }]),
      ...normalizedChildren.map((node) => ({ id: uid("edge"), from: outputRoot.id, to: node.id })),
    ],
  };
}
