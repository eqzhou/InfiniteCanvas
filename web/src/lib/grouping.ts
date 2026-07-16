import type { BoardNode } from "@/types/board";

export type GroupingResult = {
  nodes: BoardNode[];
  selectedIds: string[];
  group: BoardNode | null;
};

export function createGroup(
  nodes: BoardNode[],
  selectedIds: string[],
  groupId: string,
  padding = 32,
): GroupingResult {
  const selected = new Set(selectedIds);
  const alreadyGrouped = new Set(
    nodes.flatMap((node) => (node.type === "group" ? node.metadata.childIds ?? [] : [])),
  );
  const children = nodes.filter(
    (node) => selected.has(node.id) && node.type !== "group" && !alreadyGrouped.has(node.id),
  );
  if (children.length < 2) return { nodes, selectedIds, group: null };

  const minX = Math.min(...children.map((node) => node.position.x));
  const minY = Math.min(...children.map((node) => node.position.y));
  const maxX = Math.max(...children.map((node) => node.position.x + node.width));
  const maxY = Math.max(...children.map((node) => node.position.y + node.height));
  const group: BoardNode = {
    id: groupId,
    type: "group",
    title: "分组",
    position: { x: minX - padding, y: minY - padding },
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
    metadata: { childIds: children.map((node) => node.id) },
  };

  return {
    nodes: [group, ...nodes],
    selectedIds: [group.id],
    group,
  };
}

export function expandGroupedSelection(nodes: BoardNode[], selectedIds: string[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const expanded = new Set(selectedIds);
  for (const selectedId of selectedIds) {
    const node = byId.get(selectedId);
    if (node?.type !== "group") continue;
    for (const childId of node.metadata.childIds ?? []) expanded.add(childId);
  }
  return [...expanded];
}

export function ungroupNodes(
  nodes: BoardNode[],
  selectedIds: string[],
): { nodes: BoardNode[]; selectedIds: string[] } {
  const selected = new Set(selectedIds);
  const groups = nodes.filter((node) => selected.has(node.id) && node.type === "group");
  if (!groups.length) return { nodes, selectedIds };
  const groupIds = new Set(groups.map((group) => group.id));
  const childIds = groups.flatMap((group) => group.metadata.childIds ?? []);
  return {
    nodes: nodes.filter((node) => !groupIds.has(node.id)),
    selectedIds: [...new Set(childIds)],
  };
}

export function pruneGroupMembership(nodes: BoardNode[], deletedIds: Set<string>): BoardNode[] {
  return nodes
    .filter((node) => !deletedIds.has(node.id))
    .map((node) => {
      if (node.type !== "group") return node;
      const childIds = (node.metadata.childIds ?? []).filter((id) => !deletedIds.has(id));
      if (childIds.length === (node.metadata.childIds ?? []).length) return node;
      return { ...node, metadata: { ...node.metadata, childIds } };
    })
    .filter((node) => node.type !== "group" || Boolean(node.metadata.childIds?.length));
}
