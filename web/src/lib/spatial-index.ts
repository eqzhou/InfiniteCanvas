import { rectsIntersect } from "@/lib/geometry";
import type { BoardNode } from "@/types/board";

type Rect = { x: number; y: number; w: number; h: number };

export interface NodeSpatialIndex {
  query: (rect: Rect) => BoardNode[];
}

const DEFAULT_CELL_SIZE = 512;
const MAX_CELLS_PER_NODE = 256;
const MAX_QUERY_CELLS = 4096;

export function createNodeSpatialIndex(
  nodes: readonly BoardNode[],
  cellSize = DEFAULT_CELL_SIZE,
): NodeSpatialIndex {
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new Error("cellSize must be a positive finite number");
  }

  const buckets = new Map<string, number[]>();
  const overflow: number[] = [];

  nodes.forEach((node, index) => {
    const range = cellRange(nodeRect(node), cellSize);
    if (range.count > MAX_CELLS_PER_NODE) {
      overflow.push(index);
      return;
    }
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = cellKey(x, y);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(index);
        else buckets.set(key, [index]);
      }
    }
  });

  return {
    query: (rect) => {
      const range = cellRange(rect, cellSize);
      if (range.count > MAX_QUERY_CELLS) {
        return nodes.filter((node) => rectsIntersect(rect, nodeRect(node)));
      }

      const candidates = new Set<number>(overflow);
      for (let x = range.minX; x <= range.maxX; x += 1) {
        for (let y = range.minY; y <= range.maxY; y += 1) {
          for (const index of buckets.get(cellKey(x, y)) ?? []) candidates.add(index);
        }
      }

      return [...candidates]
        .sort((a, b) => a - b)
        .map((index) => nodes[index])
        .filter((node) => rectsIntersect(rect, nodeRect(node)));
    },
  };
}

function nodeRect(node: BoardNode): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    w: node.width,
    h: node.height,
  };
}

function cellRange(rect: Rect, cellSize: number) {
  const minX = Math.floor(rect.x / cellSize);
  const minY = Math.floor(rect.y / cellSize);
  const maxX = Math.floor((rect.x + Math.max(0, rect.w) - Number.EPSILON) / cellSize);
  const maxY = Math.floor((rect.y + Math.max(0, rect.h) - Number.EPSILON) / cellSize);
  return {
    minX,
    minY,
    maxX,
    maxY,
    count: (maxX - minX + 1) * (maxY - minY + 1),
  };
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}
