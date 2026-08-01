import type { NodeType } from "@/types/board";

const selfManagedNodeTypes = new Set<NodeType>(["group", "plugin", "director"]);

export function showsFloatingNodeActions(type: NodeType): boolean {
  return !selfManagedNodeTypes.has(type);
}
