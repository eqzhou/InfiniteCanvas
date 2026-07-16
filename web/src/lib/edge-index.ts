import { createNodeSpatialIndex } from "@/lib/spatial-index";
import type { BoardEdge, BoardNode } from "@/types/board";

export interface EdgeIndex {
  touching: (nodeIds: ReadonlySet<string>) => BoardEdge[];
}

type Rect = { x: number; y: number; w: number; h: number };

export interface EdgeGeometryIndex {
  intersecting: (rect: Rect) => BoardEdge[];
}

export function createEdgeIndex(edges: readonly BoardEdge[]): EdgeIndex {
  const byNode = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    appendIndex(byNode, edge.from, index);
    if (edge.to !== edge.from) appendIndex(byNode, edge.to, index);
  });

  return {
    touching: (nodeIds) => {
      const indices = new Set<number>();
      for (const nodeId of nodeIds) {
        for (const index of byNode.get(nodeId) ?? []) indices.add(index);
      }
      return [...indices].sort((a, b) => a - b).map((index) => edges[index]);
    },
  };
}

export function createEdgeGeometryIndex(
  edges: readonly BoardEdge[],
  nodesById: ReadonlyMap<string, BoardNode>,
): EdgeGeometryIndex {
  const edgeBySpatialId = new Map<string, BoardEdge>();
  const bounds: BoardNode[] = [];
  edges.forEach((edge, index) => {
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (!fromNode || !toNode) return;
    const from = {
      x: fromNode.position.x + fromNode.width,
      y: fromNode.position.y + fromNode.height / 2,
    };
    const to = {
      x: toNode.position.x,
      y: toNode.position.y + toNode.height / 2,
    };
    const dx = Math.max(40, Math.abs(to.x - from.x) * 0.45);
    const minX = Math.min(from.x, from.x + dx, to.x - dx, to.x);
    const maxX = Math.max(from.x, from.x + dx, to.x - dx, to.x);
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    const spatialId = `edge-bound:${index}`;
    bounds.push({
      id: spatialId,
      type: "group",
      title: spatialId,
      position: { x: minX - 4, y: minY - 4 },
      width: maxX - minX + 8,
      height: maxY - minY + 8,
      metadata: {},
    });
    edgeBySpatialId.set(spatialId, edge);
  });
  const spatial = createNodeSpatialIndex(bounds);
  return {
    intersecting: (rect) => spatial.query(rect)
      .map((entry) => edgeBySpatialId.get(entry.id))
      .filter((edge): edge is BoardEdge => edge !== undefined),
  };
}

function appendIndex(index: Map<string, number[]>, nodeId: string, edgeIndex: number): void {
  const entries = index.get(nodeId);
  if (entries) entries.push(edgeIndex);
  else index.set(nodeId, [edgeIndex]);
}
