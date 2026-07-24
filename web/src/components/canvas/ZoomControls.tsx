import { Focus, Minus, Plus } from "lucide-react";
import { clamp } from "@/lib/geometry";

export function ZoomControls({
  k,
  onChange,
  onReset,
}: {
  k: number;
  onChange: (k: number) => void;
  onReset: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="缩放控制"
      className="ob-chrome absolute bottom-3 left-3 z-30 flex items-center gap-1.5 px-2 py-1.5 sm:bottom-4 sm:left-4 sm:gap-2 sm:px-2.5 sm:py-1.5"
    >
      <button
        type="button"
        className="ob-icon-btn h-8 w-8"
        aria-label="缩小"
        onClick={() => onChange(clamp(k / 1.1, 0.15, 3))}
      >
        <Minus size={16} />
      </button>
      <input
        aria-label="缩放比例"
        className="hidden w-28 accent-[var(--ob-accent)] sm:block"
        type="range"
        min={15}
        max={300}
        value={Math.round(k * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="w-10 text-center text-xs font-medium tabular-nums text-[var(--ob-ink)] sm:w-12">
        {Math.round(k * 100)}%
      </span>
      <button
        type="button"
        className="ob-icon-btn h-8 w-8"
        aria-label="放大"
        onClick={() => onChange(clamp(k * 1.1, 0.15, 3))}
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        className="ob-icon-btn h-8 w-8"
        title="重置视图"
        onClick={onReset}
      >
        <Focus size={16} />
      </button>
    </div>
  );
}
