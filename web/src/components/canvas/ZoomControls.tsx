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
    <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1.5 shadow-[var(--ob-shadow)]">
      <button
        type="button"
        className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
        onClick={() => onChange(clamp(k / 1.1, 0.15, 3))}
      >
        <Minus size={16} />
      </button>
      <input
        type="range"
        min={15}
        max={300}
        value={Math.round(k * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="w-12 text-center text-xs tabular-nums">
        {Math.round(k * 100)}%
      </span>
      <button
        type="button"
        className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
        onClick={() => onChange(clamp(k * 1.1, 0.15, 3))}
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
        title="重置视图"
        onClick={onReset}
      >
        <Focus size={16} />
      </button>
    </div>
  );
}
