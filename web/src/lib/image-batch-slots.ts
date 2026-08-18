import { createNode } from "@/lib/defaults";
import { repairDirectorShotDeletion } from "@/lib/director-shot-generation";
import { pruneGroupMembership } from "@/lib/grouping";
import { canRetryImageResult } from "@/lib/image-generation";
import { uid } from "@/lib/id";
import type { BoardNode, BoardProject, Point } from "@/types/board";

export const IMAGE_BATCH_COLUMNS = 4;

export function expandImageBatchPositions(
  root: Pick<BoardNode, "position" | "width" | "height">,
  childIds: readonly string[],
): Record<string, Point> {
  const columnStride = Math.max(300, root.width + 48);
  const rowStride = Math.max(300, root.height + 48);
  return Object.fromEntries(childIds.map((id, index) => [id, {
    x: root.position.x + root.width + 48 + (index % IMAGE_BATCH_COLUMNS) * columnStride,
    y: root.position.y + Math.floor(index / IMAGE_BATCH_COLUMNS) * rowStride,
  }]));
}

export function collapseImageBatchPositions(
  root: Pick<BoardNode, "position">,
  childIds: readonly string[],
): Record<string, Point> {
  return Object.fromEntries(childIds.map((id, index) => [id, {
    x: root.position.x + 12 + index * 8,
    y: root.position.y + 12 + index * 8,
  }]));
}

function applyPositions(project: BoardProject, positions: Record<string, Point>): BoardProject {
  return {
    ...project,
    nodes: project.nodes.map((node) => {
      const position = positions[node.id];
      return position ? { ...node, position } : node;
    }),
  };
}

export function layoutImageBatch(project: BoardProject, rootId: string): BoardProject {
  const root = project.nodes.find((node) => node.id === rootId);
  if (!root?.metadata.isBatchRoot) return project;
  const childIds = root.metadata.batchChildIds ?? [];
  const positions = root.metadata.imageBatchExpanded === false
    ? collapseImageBatchPositions(root, childIds)
    : expandImageBatchPositions(root, childIds);
  return applyPositions(project, positions);
}

export function deleteImageBatchSlot(project: BoardProject, slotId: string): BoardProject {
  const slot = project.nodes.find((node) => node.id === slotId);
  const rootId = slot?.metadata.batchRootId
    ?? (slot?.metadata.isBatchRoot ? slot.id : project.nodes.find((node) => node.metadata.batchChildIds?.includes(slotId))?.id);
  if (!rootId || (rootId === slotId && slot?.metadata.isBatchRoot)) return project;
  const root = project.nodes.find((node) => node.id === rootId);
  if (!root) return project;
  const childIds = (root.metadata.batchChildIds ?? []).filter((id) => id !== slotId);
  const primaryImageId = root.metadata.primaryImageId === slotId ? childIds[0] : root.metadata.primaryImageId;
  const deleted = new Set([slotId]);
  const next = {
    ...project,
    nodes: repairDirectorShotDeletion(
      pruneGroupMembership(
        project.nodes.map((node) => node.id === rootId
          ? {
              ...node,
              metadata: {
                ...node.metadata,
                batchChildIds: childIds.length ? childIds : undefined,
                primaryImageId: childIds.length ? primaryImageId : undefined,
                isBatchRoot: childIds.length ? true : undefined,
                imageBatchExpanded: childIds.length ? node.metadata.imageBatchExpanded : undefined,
              },
            }
          : node),
        deleted,
      ),
      deleted,
    ),
    edges: project.edges.filter((edge) => edge.from !== slotId && edge.to !== slotId),
  };
  return childIds.length ? layoutImageBatch(next, rootId) : next;
}

export function duplicateImageBatchSlot(project: BoardProject, slotId: string): BoardProject {
  const slot = project.nodes.find((node) => node.id === slotId);
  if (!slot || slot.type !== "image" && slot.type !== "panorama") return project;
  const copy = createNode(slot.type, {
    x: slot.position.x + slot.width + 32,
    y: slot.position.y,
  }, {
    id: uid("node"),
    title: `${slot.title} copy`,
    width: slot.width,
    height: slot.height,
    metadata: {
      ...slot.metadata,
      isBatchRoot: undefined,
      batchRootId: undefined,
      batchChildIds: undefined,
      imageBatchExpanded: undefined,
      primaryImageId: undefined,
      generationRunId: undefined,
      generationJobId: undefined,
      generationResultIndex: undefined,
      status: slot.metadata.status === "loading" ? "idle" : slot.metadata.status,
      errorDetails: undefined,
    },
  });
  return { ...project, nodes: [...project.nodes, copy] };
}

export function imageBatchSlotActions(
  node: Pick<BoardNode, "type" | "metadata">,
  options: { hasMedia: boolean },
): { retry: boolean; deleteSlot: boolean; download: boolean; duplicate: boolean } {
  const isRoot = Boolean(node.metadata.isBatchRoot);
  return {
    retry: node.type === "image" && canRetryImageResult(node.metadata),
    deleteSlot: !isRoot,
    download: options.hasMedia,
    duplicate: options.hasMedia,
  };
}
