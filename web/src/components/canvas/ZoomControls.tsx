import { Focus, Minus, Plus } from "lucide-react";
import { clamp } from "@/lib/geometry";
import { useI18n } from "@/i18n/I18nProvider";

export function ZoomControls({
  k,
  onChange,
  onCommit,
  onReset,
}: {
  k: number;
  onChange: (k: number) => void;
  onCommit: () => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const changeAndCommit = (next: number) => {
    onChange(next);
    onCommit();
  };

  return (
    <div
      role="group"
      aria-label={t("canvas.zoomControls")}
      data-canvas-control
      className="ob-chrome absolute bottom-3 left-3 z-30 flex items-center gap-1.5 px-2 py-1.5 sm:bottom-4 sm:left-4 sm:gap-2 sm:px-2.5 sm:py-1.5"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="ob-icon-btn h-8 w-8"
        aria-label={t("canvas.zoomOut")}
        onClick={() => changeAndCommit(clamp(k / 1.1, 0.15, 3))}
      >
        <Minus size={16} />
      </button>
      <input
        aria-label={t("canvas.zoomLevel")}
        aria-valuetext={`${Math.round(k * 100)}%`}
        className="hidden w-28 accent-[var(--ob-accent)] sm:block"
        type="range"
        min={15}
        max={300}
        step={1}
        value={Math.round(k * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onPointerUp={onCommit}
        onPointerCancel={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
      <span className="w-10 text-center text-xs font-medium tabular-nums text-[var(--ob-ink)] sm:w-12">
        {Math.round(k * 100)}%
      </span>
      <button
        type="button"
        className="ob-icon-btn h-8 w-8"
        aria-label={t("canvas.zoomIn")}
        onClick={() => changeAndCommit(clamp(k * 1.1, 0.15, 3))}
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        className="ob-icon-btn h-8 w-8"
        title={t("canvas.resetView")}
        aria-label={t("canvas.resetView")}
        onClick={onReset}
      >
        <Focus size={16} />
      </button>
    </div>
  );
}
