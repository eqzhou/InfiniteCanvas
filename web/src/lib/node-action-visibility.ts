import type { BoardNode, NodeType } from "@/types/board";

const selfManagedNodeTypes = new Set<NodeType>(["group", "plugin", "director"]);

export function showsFloatingNodeActions(type: NodeType): boolean {
  return !selfManagedNodeTypes.has(type);
}

export function hasImageSource(node: Pick<BoardNode, "type" | "metadata">): boolean {
  return node.type === "image" && Boolean(node.metadata.content || node.metadata.storageKey);
}

export function shouldShowImageGenerationAction(node: Pick<BoardNode, "type" | "metadata">): boolean {
  return node.type !== "image" || hasImageSource(node);
}
