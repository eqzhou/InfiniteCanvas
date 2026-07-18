import type { BoardNode, Viewport } from "@/types/board";
import { useMemo } from "react";

export function MiniMap({
  nodes,
  viewport,
  width,
  height,
  onJump,
}: {
  nodes: BoardNode[];
  viewport: Viewport;
  width: number;
  height: number;
  onJump: (v: Viewport) => void;
}) {
  const bounds = useMemo(() => {
    if (!nodes.length) return { minX: -400, minY: -300, maxX: 400, maxY: 300 };
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + n.width);
      maxY = Math.max(maxY, n.position.y + n.height);
    }
    const pad = 120;
    return {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
    };
  }, [nodes]);

  const compact = width < 640;
  const mw = compact ? 128 : 180;
  const mh = compact ? 88 : 120;
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  const scale = Math.min(mw / bw, mh / bh);

  const view = {
    x: (-viewport.x / viewport.k - bounds.minX) * scale,
    y: (-viewport.y / viewport.k - bounds.minY) * scale,
    w: (width / viewport.k) * scale,
    h: (height / viewport.k) * scale,
  };

  return (
    <button
      type="button"
      aria-label="画布小地图"
      className="absolute bottom-3 right-3 overflow-hidden rounded-md border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-panel)_92%,transparent)] shadow-[var(--ob-shadow)] sm:bottom-4 sm:right-4 sm:rounded-lg"
      style={{ width: mw, height: mh }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const worldX = mx / scale + bounds.minX;
        const worldY = my / scale + bounds.minY;
        onJump({
          k: viewport.k,
          x: width / 2 - worldX * viewport.k,
          y: height / 2 - worldY * viewport.k,
        });
      }}
    >
      <svg width={mw} height={mh}>
        {nodes.map((n) => (
          <rect
            key={n.id}
            x={(n.position.x - bounds.minX) * scale}
            y={(n.position.y - bounds.minY) * scale}
            width={Math.max(2, n.width * scale)}
            height={Math.max(2, n.height * scale)}
            fill={n.type === "group" ? "none" : "var(--ob-accent)"}
            stroke={n.type === "group" ? "var(--ob-accent)" : "none"}
            strokeDasharray={n.type === "group" ? "3 2" : undefined}
            opacity={n.type === "group" ? 0.8 : 0.55}
            rx={1}
          />
        ))}
        <rect
          x={view.x}
          y={view.y}
          width={view.w}
          height={view.h}
          fill="none"
          stroke="var(--ob-select)"
          strokeWidth={1.5}
        />
      </svg>
    </button>
  );
}
