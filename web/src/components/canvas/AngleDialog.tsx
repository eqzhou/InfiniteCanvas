import { useState } from "react";
import { createPortal } from "react-dom";
import type { BoardNode } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

const PRESETS = [0, 15, 30, 45, 90, 180, 270, -15, -30, -45];

export function AngleDialog({
  node,
  open,
  onClose,
  onConfirm,
}: {
  node: BoardNode;
  open: boolean;
  onClose: () => void;
  onConfirm: (degrees: number) => void;
}) {
  const [deg, setDeg] = useState(15);
  useEscapeDismiss(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/45 p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 shadow-[var(--ob-shadow)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">多角度变换</h3>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        {node.metadata.content ? (
          <div className="mb-3 grid place-items-center overflow-hidden rounded-lg bg-[var(--ob-canvas)] p-4">
            <img
              src={node.metadata.content}
              alt=""
              className="max-h-48 max-w-full object-contain"
              style={{ transform: `rotate(${deg}deg)` }}
            />
          </div>
        ) : null}
        <label className="mb-2 flex flex-col gap-1 text-sm">
          角度（度）
          <input
            type="number"
            className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
            value={deg}
            onChange={(e) => setDeg(Number(e.target.value) || 0)}
          />
        </label>
        <div className="mb-4 flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className="rounded border border-[var(--ob-line)] px-2 py-0.5 text-xs hover:bg-[var(--ob-accent-soft)]"
              onClick={() => setDeg(p)}
            >
              {p}°
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-[var(--ob-line)] px-3 py-1.5"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-[var(--ob-accent)] px-3 py-1.5 text-white"
            onClick={() => onConfirm(deg)}
          >
            生成变换节点
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
