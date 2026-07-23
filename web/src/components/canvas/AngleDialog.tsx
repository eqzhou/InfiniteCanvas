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
    <div className="ob-overlay-canvas p-4">
      <div className="ob-dialog max-w-md p-4">
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
            className="ob-field px-2 py-1"
            value={deg}
            onChange={(e) => setDeg(Number(e.target.value) || 0)}
          />
        </label>
        <div className="mb-4 flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className="ob-btn px-2 py-0.5 text-xs"
              onClick={() => setDeg(p)}
            >
              {p}°
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="ob-btn px-3 py-1.5"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="ob-btn-primary px-3 py-1.5"
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
