import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
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
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="angle-dialog-title"
        className="ob-dialog max-w-md p-0"
      >
        <header className="ob-dialog-header px-4 py-3">
          <div className="min-w-0">
            <p className="ob-page-kicker">Transform</p>
            <h2 id="angle-dialog-title" className="text-base font-semibold tracking-tight">
              多角度变换
            </h2>
          </div>
          <button
            type="button"
            className="ob-icon-btn ml-auto"
            aria-label="关闭角度对话框"
            title="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="ob-dialog-body space-y-3">
          {node.metadata.content ? (
            <div className="grid place-items-center overflow-hidden rounded-xl bg-[var(--ob-canvas)] p-4 shadow-[var(--ob-elev-1)]">
              <img
                src={node.metadata.content}
                alt=""
                className="max-h-48 max-w-full object-contain"
                style={{ transform: `rotate(${deg}deg)` }}
              />
            </div>
          ) : null}
          <label className="block text-sm">
            <span className="ob-label">角度（度）</span>
            <input
              type="number"
              className="ob-field"
              value={deg}
              onChange={(e) => setDeg(Number(e.target.value) || 0)}
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`ob-btn px-2.5 py-1 text-xs ${deg === p ? "border-[var(--ob-accent)] text-[var(--ob-accent)]" : ""}`}
                aria-pressed={deg === p}
                onClick={() => setDeg(p)}
              >
                {p}°
              </button>
            ))}
          </div>
        </div>
        <div className="ob-dialog-footer">
          <button type="button" className="ob-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ob-btn-primary" onClick={() => onConfirm(deg)}>
            生成变换节点
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
