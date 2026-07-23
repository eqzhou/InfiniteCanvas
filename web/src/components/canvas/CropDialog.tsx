import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardNode } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

type Props = {
  node: BoardNode;
  open: boolean;
  onClose: () => void;
  onConfirm: (crop: { x: number; y: number; w: number; h: number }) => void;
};

export function CropDialog({ node, open, onClose, onConfirm }: Props) {
  useEscapeDismiss(open, onClose);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [w, setW] = useState(100);
  const [h, setH] = useState(100);

  useEffect(() => {
    if (!open || !node.metadata.content) return;
    const img = new Image();
    img.onload = () => {
      const nw = img.naturalWidth || node.metadata.naturalWidth || 512;
      const nh = img.naturalHeight || node.metadata.naturalHeight || 512;
      setNatural({ w: nw, h: nh });
      const side = Math.min(nw, nh);
      setX(Math.round((nw - side) / 4));
      setY(Math.round((nh - side) / 4));
      setW(Math.round(side / 2));
      setH(Math.round(side / 2));
    };
    img.src = node.metadata.content;
  }, [open, node]);

  const previewStyle = useMemo(() => {
    if (!natural.w || !natural.h) return {};
    const scale = 280 / Math.max(natural.w, natural.h);
    return {
      width: natural.w * scale,
      height: natural.h * scale,
      backgroundImage: `url(${node.metadata.content})`,
      backgroundSize: "cover",
    } as React.CSSProperties;
  }, [natural, node.metadata.content]);

  if (!open) return null;

  const scale = natural.w ? 280 / Math.max(natural.w, natural.h) : 1;

  return createPortal(
    <div className="ob-overlay-canvas p-4">
      <div className="ob-dialog max-w-lg p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">裁剪图片</h3>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="mb-3 grid place-items-center rounded-lg bg-[var(--ob-canvas)] p-3">
          <div className="relative overflow-hidden" style={previewStyle}>
            <div
              className="absolute border-2 border-[var(--ob-select)] bg-[color-mix(in_srgb,var(--ob-select)_20%,transparent)]"
              style={{
                left: x * scale,
                top: y * scale,
                width: w * scale,
                height: h * scale,
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Num label="X" value={x} max={natural.w} onChange={setX} />
          <Num label="Y" value={y} max={natural.h} onChange={setY} />
          <Num label="宽" value={w} max={natural.w} onChange={setW} />
          <Num label="高" value={h} max={natural.h} onChange={setH} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
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
            onClick={() =>
              onConfirm({
                x: Math.max(0, x),
                y: Math.max(0, y),
                w: Math.max(1, w),
                h: Math.max(1, h),
              })
            }
          >
            生成裁剪节点
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Num({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="ob-label">
        {label} {max ? `(0-${max})` : ""}
      </span>
      <input
        type="number"
        className="ob-field px-2 py-1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
}
