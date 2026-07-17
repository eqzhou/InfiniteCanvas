import type { BoardNode } from "@/types/board";

export type GroupingResult = {
  nodes: BoardNode[];
  selectedIds: string[];
  group: BoardNode | null;
};

export const GROUP_PADDING = 24;
export const GROUP_EXIT_THRESHOLD = 16;

type Bounds = { left: number; top: number; right: number; bottom: number };

function bounds(node: BoardNode): Bounds {
  return {
    left: node.position.x,
    top: node.position.y,
    right: node.position.x + node.width,
    bottom: node.position.y + node.height,
  };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function outsideByMoreThan(node: Bounds, group: Bounds, threshold: number): boolean {
  return node.left < group.left - threshold ||
    node.right > group.right + threshold ||
    node.top < group.top - threshold ||
    node.bottom > group.bottom + threshold;
}

function fitGroup(group: BoardNode, children: BoardNode[], padding: number): BoardNode {
  if (!children.length) return group;
  const minX = Math.min(...children.map((node) => node.position.x));
  const minY = Math.min(...children.map((node) => node.position.y));
  const maxX = Math.max(...children.map((node) => node.position.x + node.width));
  const maxY = Math.max(...children.map((node) => node.position.y + node.height));
  return {
    ...group,
    position: { x: minX - padding, y: minY - padding },
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

export function reconcileGroupMembership(
  nodes: BoardNode[],
  movedIds: string[],
  options: { padding?: number; exitThreshold?: number } = {},
): { nodes: BoardNode[]; changed: boolean } {
  const padding = options.padding ?? GROUP_PADDING;
  const exitThreshold = options.exitThreshold ?? GROUP_EXIT_THRESHOLD;
  const moved = new Set(movedIds);
  const originalById = new Map(nodes.map((node) => [node.id, node]));
  const groups = nodes.filter((node) => node.type === "group");
  const owner = new Map<string, string>();
  for (const group of groups) {
    for (const childId of group.metadata.childIds ?? []) owner.set(childId, group.id);
  }

  const memberships = new Map(
    groups.map((group) => [group.id, [...(group.metadata.childIds ?? [])]]),
  );
  let changed = false;

  for (const node of nodes) {
    if (!moved.has(node.id) || node.type === "group") continue;
    const currentOwner = owner.get(node.id);
    if (currentOwner) {
      const group = originalById.get(currentOwner);
      if (group && outsideByMoreThan(bounds(node), bounds(group), exitThreshold)) {
        memberships.set(
          group.id,
          (memberships.get(group.id) ?? []).filter((id) => id !== node.id),
        );
        owner.delete(node.id);
        changed = true;
      }
    }
    if (owner.has(node.id)) continue;
    const target = groups.find((group) =>
      group.id !== currentOwner && intersects(bounds(node), bounds(group)),
    );
    if (!target) continue;
    memberships.set(target.id, [...(memberships.get(target.id) ?? []), node.id]);
    owner.set(node.id, target.id);
    changed = true;
  }

  const membershipByChild = new Map<string, string>();
  for (const [groupId, childIds] of memberships) {
    for (const childId of childIds) membershipByChild.set(childId, groupId);
  }
  const next = nodes.map((node) => {
    if (node.type !== "group") return node;
    const childIds = memberships.get(node.id) ?? [];
    const withMembership = {
      ...node,
      metadata: { ...node.metadata, childIds },
    };
    const children = nodes.filter((candidate) => membershipByChild.get(candidate.id) === node.id);
    const fitted = fitGroup(withMembership, children, padding);
    if (
      fitted.position.x !== node.position.x || fitted.position.y !== node.position.y ||
      fitted.width !== node.width || fitted.height !== node.height ||
      childIds.length !== (node.metadata.childIds ?? []).length ||
      childIds.some((id, index) => id !== node.metadata.childIds?.[index])
    ) {
      changed = true;
      return fitted;
    }
    return node;
  }).filter((node) => {
    if (node.type !== "group" || node.metadata.childIds?.length) return true;
    changed = true;
    return false;
  });
  return changed ? { nodes: next, changed: true } : { nodes, changed: false };
}

export function createGroup(
  nodes: BoardNode[],
  selectedIds: string[],
  groupId: string,
  padding = GROUP_PADDING,
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
