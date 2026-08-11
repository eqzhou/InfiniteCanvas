import type { BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { Layers, Star } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";

export function batchResultCount(
  metadata: Pick<BoardNode["metadata"], "content" | "generationRunId" | "batchChildIds">,
  childCount: number,
): number {
  const rootIsPreview = Boolean(metadata.generationRunId && metadata.batchChildIds?.length);
  return childCount + (!rootIsPreview && metadata.content ? 1 : 0);
}

/** Controls for multi-result image batches (stack / expand / primary). */
export function BatchGroupControls({ node }: { node: BoardNode }) {
  const { t } = useI18n();
  const project = useBoardStore((s) => s.getActive());
  const updateActive = useBoardStore((s) => s.updateActive);
  const updateNode = useBoardStore((s) => s.updateNode);

  if (!project) return null;
  const isRoot = Boolean(node.metadata.isBatchRoot);
  const isChild = Boolean(node.metadata.batchRootId);
  if (!isRoot && !isChild) return null;

  const rootId = isRoot ? node.id : node.metadata.batchRootId!;
  const root = project.nodes.find((n) => n.id === rootId) ?? node;
  const childIds = root.metadata.batchChildIds ?? [];
  const children = project.nodes.filter((n) => childIds.includes(n.id));
  const expanded = root.metadata.imageBatchExpanded !== false;
  const primaryId = root.metadata.primaryImageId ?? childIds[0];
  const panoramaBatch = root.type === "panorama";
  const rootIsPreview = Boolean(root.metadata.generationRunId && childIds.length);

  const toggleExpand = () => {
    updateActive((p) => {
      const nextExpanded = !expanded;
      return {
        ...p,
        nodes: p.nodes.map((n) => {
          if (n.id === rootId) {
            return {
              ...n,
              metadata: { ...n.metadata, imageBatchExpanded: nextExpanded },
            };
          }
          if (childIds.includes(n.id)) {
            // collapse: stack children under root with offsets
            if (!nextExpanded) {
              const idx = childIds.indexOf(n.id);
              return {
                ...n,
                position: {
                  x: root.position.x + 12 + idx * 8,
                  y: root.position.y + 12 + idx * 8,
                },
              };
            }
            // expand: fan out to the right
            const idx = childIds.indexOf(n.id);
            const columnStride = Math.max(300, root.width + 48);
            const rowStride = Math.max(300, root.height + 48);
            return {
              ...n,
              position: {
                x: root.position.x + root.width + 48 + (idx % 3) * columnStride,
                y: root.position.y + Math.floor(idx / 3) * rowStride,
              },
            };
          }
          return n;
        }),
      };
    });
  };

  const setPrimary = (id: string) => {
    updateNode(rootId, { metadata: { primaryImageId: id } });
  };

  return (
    <div
      data-canvas-control
      className="absolute -bottom-9 right-0 flex items-center gap-1 rounded-md border border-[var(--ob-line)] bg-[var(--ob-panel)] p-1 text-[11px] shadow-[var(--ob-shadow)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="px-1 text-[var(--ob-muted)]">
        {panoramaBatch ? t("batch.panoramaGroup") : t("batch.group")} {batchResultCount(root.metadata, children.length)}
      </span>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--ob-accent-soft)]"
        title={expanded ? t("batch.collapseStack") : t("batch.expandAll")}
        onClick={toggleExpand}
      >
        <Layers size={12} />
        {expanded ? t("batch.collapse") : t("batch.expand")}
      </button>
      {isChild || (isRoot && node.metadata.content && !rootIsPreview) ? (
        <button
          type="button"
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--ob-accent-soft)] ${
            primaryId === node.id ? "text-[var(--ob-accent)]" : ""
          }`}
          title={panoramaBatch ? t("batch.setPrimaryPanorama") : t("batch.setPrimaryImage")}
          aria-label={panoramaBatch
            ? (primaryId === node.id ? t("batch.currentPrimaryPanorama") : t("batch.setPrimaryPanorama"))
            : (primaryId === node.id ? t("batch.currentPrimaryImage") : t("batch.setPrimaryImage"))}
          aria-pressed={primaryId === node.id}
          onClick={() => setPrimary(node.id)}
        >
          <Star size={12} fill={primaryId === node.id ? "currentColor" : "none"} />
          {panoramaBatch ? t("batch.primaryResult") : t("batch.primaryImage")}
        </button>
      ) : null}
    </div>
  );
}
