import type { BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { Layers, Star } from "lucide-react";

/** Controls for multi-result image batches (stack / expand / primary). */
export function BatchGroupControls({ node }: { node: BoardNode }) {
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
                width: Math.min(n.width, root.width - 20),
                height: Math.min(n.height, root.height - 20),
              };
            }
            // expand: fan out to the right
            const idx = childIds.indexOf(n.id);
            return {
              ...n,
              position: {
                x: root.position.x + root.width + 48 + (idx % 3) * 300,
                y: root.position.y + Math.floor(idx / 3) * 300,
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
      className="absolute -bottom-9 right-0 flex items-center gap-1 rounded-md border border-[var(--ob-line)] bg-[var(--ob-panel)] p-1 text-[11px] shadow-[var(--ob-shadow)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="px-1 text-[var(--ob-muted)]">
        组 {children.length + (root.metadata.content ? 1 : 0)}
      </span>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--ob-accent-soft)]"
        title={expanded ? "叠卡收起" : "展开全部"}
        onClick={toggleExpand}
      >
        <Layers size={12} />
        {expanded ? "收起" : "展开"}
      </button>
      {isChild || (isRoot && node.metadata.content) ? (
        <button
          type="button"
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--ob-accent-soft)] ${
            primaryId === node.id ? "text-[var(--ob-accent)]" : ""
          }`}
          title="设为主图"
          onClick={() => setPrimary(node.id)}
        >
          <Star size={12} fill={primaryId === node.id ? "currentColor" : "none"} />
          主图
        </button>
      ) : null}
    </div>
  );
}
