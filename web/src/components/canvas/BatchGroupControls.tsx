import type { BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { Copy, Download, Layers, RotateCcw, Star, Trash2 } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";
import { toast } from "@/components/common/toast";
import { downloadStorageKey } from "@/services/storage";
import { deleteGenerationJobsForNodeIds } from "@/services/generation-jobs";
import { filenameForMimeType } from "@/lib/download-filename";
import {
  generationCleanupNodeIdsAfterDeletion,
  orphanedGenerationJobIdsAfterDeletion,
} from "@/lib/director-shot-generation";
import {
  collapseImageBatchPositions,
  deleteImageBatchSlot,
  duplicateImageBatchSlot,
  expandImageBatchPositions,
  imageBatchSlotActions,
} from "@/lib/image-batch-slots";

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
  const persistNow = useBoardStore((s) => s.persistNow);
  const requestImageRetry = useBoardStore((s) => s.requestImageRetry);
  const setSelected = useBoardStore((s) => s.setSelected);

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
      const currentRoot = p.nodes.find((n) => n.id === rootId);
      if (!currentRoot?.metadata.isBatchRoot) return p;
      const currentChildIds = currentRoot.metadata.batchChildIds ?? [];
      const nextExpanded = currentRoot.metadata.imageBatchExpanded === false;
      const positions = nextExpanded
        ? expandImageBatchPositions(currentRoot, currentChildIds)
        : collapseImageBatchPositions(currentRoot, currentChildIds);
      return {
        ...p,
        nodes: p.nodes.map((n) => {
          if (n.id === rootId) {
            return {
              ...n,
              metadata: { ...n.metadata, imageBatchExpanded: nextExpanded },
            };
          }
          if (currentChildIds.includes(n.id)) {
            return { ...n, position: positions[n.id] ?? n.position };
          }
          return n;
        }),
      };
    });
  };

  const setPrimary = (id: string) => {
    updateNode(rootId, { metadata: { primaryImageId: id } });
  };

  const actions = imageBatchSlotActions(node, {
    hasMedia: Boolean(node.metadata.storageKey || node.metadata.content),
  });
  const downloadSlot = async () => {
    if (node.metadata.storageKey) {
      try {
        await downloadStorageKey(
          node.metadata.storageKey,
          filenameForMimeType(node.title || node.id, node.metadata.mimeType, "jpg"),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("batch.downloadFailed"));
      }
      return;
    }
    if (!node.metadata.content || !/^(?:blob:|data:image\/)/i.test(node.metadata.content)) {
      toast.warn(t("batch.downloadMissing"));
      return;
    }
    const link = document.createElement("a");
    link.href = node.metadata.content;
    link.download = filenameForMimeType(node.title || node.id, node.metadata.mimeType, "jpg");
    link.click();
  };
  const retrySlot = () => {
    setSelected([node.id]);
    requestImageRetry(node.id);
  };
  const deleteSlot = () => {
    const selected = new Set([node.id]);
    const nodeJobIds = orphanedGenerationJobIdsAfterDeletion(project, selected);
    const generationCleanupNodeIds = generationCleanupNodeIdsAfterDeletion(project, selected);
    updateActive((current) => deleteImageBatchSlot(current, node.id), { history: true });
    setSelected([]);
    void deleteGenerationJobsForNodeIds(project.id, generationCleanupNodeIds, { nodeJobIds }).catch(() => 0);
    void persistNow();
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
      {actions.retry ? (
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--ob-accent-soft)]" title={t("batch.retryFailed")} aria-label={t("batch.retryFailed")} onClick={retrySlot}>
          <RotateCcw size={12} />
          {t("batch.retry")}
        </button>
      ) : null}
      {actions.download ? (
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--ob-accent-soft)]" title={t("batch.downloadImage")} aria-label={t("batch.downloadImage")} onClick={() => void downloadSlot()}>
          <Download size={12} />
          {t("batch.download")}
        </button>
      ) : null}
      {actions.duplicate ? (
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--ob-accent-soft)]" title={t("batch.duplicateImage")} aria-label={t("batch.duplicateImage")} onClick={() => { updateActive((current) => duplicateImageBatchSlot(current, node.id), { history: true }); void persistNow(); }}>
          <Copy size={12} />
          {t("batch.duplicate")}
        </button>
      ) : null}
      {actions.deleteSlot ? (
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--ob-danger)] hover:bg-[var(--ob-accent-soft)]" title={t("batch.deleteFailed")} aria-label={t("batch.deleteSlot")} onClick={deleteSlot}>
          <Trash2 size={12} />
          {t("batch.delete")}
        </button>
      ) : null}
    </div>
  );
}
