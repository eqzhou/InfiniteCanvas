import type { BoardNode, Point } from "@/types/board";

type Size = { width: number; height: number };

function overlapsWithGap(position: Point, size: Size, node: BoardNode, gap: number): boolean {
  return position.x < node.position.x + node.width + gap &&
    position.x + size.width + gap > node.position.x &&
    position.y < node.position.y + node.height + gap &&
    position.y + size.height + gap > node.position.y;
}

export function findOpenNodePosition(
  nodes: readonly BoardNode[],
  preferred: Point,
  size: Size,
  gap = 32,
): Point {
  for (let column = 0; column <= nodes.length; column += 1) {
    const candidate = {
      x: preferred.x + column * (size.width + gap),
      y: preferred.y,
    };
    if (!nodes.some((node) => overlapsWithGap(candidate, size, node, gap))) {
      return candidate;
    }
  }
  return {
    x: preferred.x + (nodes.length + 1) * (size.width + gap),
    y: preferred.y,
  };
}
