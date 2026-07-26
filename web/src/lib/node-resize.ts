/**
 * Corner resize geometry.
 *
 * Each corner drag keeps the diagonally opposite corner pinned, so resizing
 * feels anchored rather than sliding the whole node. Ratio locking and the
 * minimum size clamp must both preserve that anchor.
 */

export const NODE_RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;
export type NodeResizeCorner = (typeof NODE_RESIZE_CORNERS)[number];

export const NODE_MIN_WIDTH = 120;
export const NODE_MIN_HEIGHT = 80;

export type NodeRect = { x: number; y: number; width: number; height: number };

/** Which edges a corner moves: the anchor is always the opposite corner. */
function cornerDirection(corner: NodeResizeCorner): { dx: -1 | 1; dy: -1 | 1 } {
  return {
    dx: corner === "nw" || corner === "sw" ? -1 : 1,
    dy: corner === "nw" || corner === "ne" ? -1 : 1,
  };
}

export function resizeFromCorner(
  origin: NodeRect,
  corner: NodeResizeCorner,
  delta: { x: number; y: number },
  free: boolean,
): NodeRect {
  const { dx, dy } = cornerDirection(corner);
  let width = origin.width + dx * delta.x;
  let height = origin.height + dy * delta.y;

  if (!free) {
    const ratio = origin.width / Math.max(1, origin.height);
    // Follow whichever axis the pointer moved further along, matching the
    // single-handle behavior users already know.
    if (Math.abs(delta.x) > Math.abs(delta.y)) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
  }

  width = Math.max(NODE_MIN_WIDTH, width);
  height = Math.max(NODE_MIN_HEIGHT, height);

  // Re-derive the position from the pinned corner so clamping cannot drift it.
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;
  return {
    x: dx === -1 ? right - width : origin.x,
    y: dy === -1 ? bottom - height : origin.y,
    width,
    height,
  };
}
