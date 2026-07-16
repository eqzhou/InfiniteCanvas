import type { BoardNode, Point, Viewport } from "@/types/board";

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.x) / viewport.k,
    y: (point.y - viewport.y) / viewport.k,
  };
}

export function worldToScreen(point: Point, viewport: Viewport): Point {
  return {
    x: point.x * viewport.k + viewport.x,
    y: point.y * viewport.k + viewport.y,
  };
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function fitMediaDisplaySize(
  width: number,
  height: number,
  minLongestSide = 120,
  maxLongestSide = 420,
): { width: number; height: number } {
  const naturalWidth = Number.isFinite(width) && width > 0 ? width : 320;
  const naturalHeight = Number.isFinite(height) && height > 0 ? height : 320;
  const longest = Math.max(naturalWidth, naturalHeight);
  const scale = longest < minLongestSide
    ? minLongestSide / longest
    : Math.min(1, maxLongestSide / longest);
  return {
    width: Math.max(24, naturalWidth * scale),
    height: Math.max(24, naturalHeight * scale),
  };
}

export function nodeCenter(node: BoardNode): Point {
  return {
    x: node.position.x + node.width / 2,
    y: node.position.y + node.height / 2,
  };
}

export function nodePort(node: BoardNode, side: "left" | "right"): Point {
  return {
    x: side === "left" ? node.position.x : node.position.x + node.width,
    y: node.position.y + node.height / 2,
  };
}

export function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function edgePath(from: Point, to: Point): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

export function fitViewport(
  nodes: BoardNode[],
  width: number,
  height: number,
  padding = 80,
): Viewport {
  if (!nodes.length) return { x: width / 2, y: height / 2, k: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.width);
    maxY = Math.max(maxY, n.position.y + n.height);
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const k = clamp(
    Math.min((width - padding * 2) / bw, (height - padding * 2) / bh),
    0.15,
    2,
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: width / 2 - cx * k,
    y: height / 2 - cy * k,
    k,
  };
}

export function nodesInViewport(
  nodes: BoardNode[],
  viewport: Viewport,
  screenWidth: number,
  screenHeight: number,
  overscan = 240,
): BoardNode[] {
  const worldRect = viewportWorldRect(viewport, screenWidth, screenHeight, overscan);
  return nodes.filter((node) =>
    rectsIntersect(worldRect, {
      x: node.position.x,
      y: node.position.y,
      w: node.width,
      h: node.height,
    }),
  );
}

export function viewportWorldRect(
  viewport: Viewport,
  screenWidth: number,
  screenHeight: number,
  overscan = 240,
): { x: number; y: number; w: number; h: number } {
  return {
    x: (-viewport.x - overscan) / viewport.k,
    y: (-viewport.y - overscan) / viewport.k,
    w: (screenWidth + overscan * 2) / viewport.k,
    h: (screenHeight + overscan * 2) / viewport.k,
  };
}
