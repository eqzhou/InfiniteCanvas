import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X, ZoomIn } from "lucide-react";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

export function ImagePreviewDialog({
  open,
  src,
  alt,
  video = false,
  onClose,
}: {
  open: boolean;
  src: string;
  alt: string;
  video?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEscapeDismiss(open, onClose, 100);

  useLayoutEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  }, [open, src]);

  useEffect(() => {
    if (!open || video) return;
    const node = dialogRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((current) => clampZoom(current + direction));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [open, video]);

  if (!open) return null;

  const resetView = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const zoomBy = (delta: number) => {
    setZoom((current) => clampZoom(current + delta));
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={video ? t("common.video") : t("canvas.imagePreview")}
      tabIndex={-1}
      className="ob-overlay z-[140] bg-black/85 p-3 sm:p-6"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {!video ? (
        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/15 bg-black/65 p-1 text-white shadow-lg backdrop-blur-sm sm:top-5">
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/10 disabled:opacity-40"
            title={t("canvas.zoomOut")}
            aria-label={t("canvas.zoomOutImage")}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomBy(-ZOOM_STEP)}
          >
            <Minus size={16} />
          </button>
          <span className="min-w-14 px-1 text-center text-xs tabular-nums" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/10 disabled:opacity-40"
            title={t("canvas.zoomIn")}
            aria-label={t("canvas.zoomInImage")}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/10"
            title={t("canvas.resetZoom")}
            aria-label={t("canvas.resetZoom")}
            onClick={resetView}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      ) : null}

      <button
        type="button"
        title={t("canvas.closePreview")}
        aria-label={t("canvas.closePreview")}
        className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-xl bg-black/55 text-white shadow-lg backdrop-blur-sm hover:bg-black/75 sm:right-5 sm:top-5"
        onClick={onClose}
      >
        <X size={20} />
      </button>

      <div
        className="relative grid h-full w-full place-items-center overflow-hidden"
        onPointerDown={(event) => {
          if (video || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offset.x,
            originY: offset.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (video) return;
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setOffset({
            x: drag.originX + (event.clientX - drag.startX),
            y: drag.originY + (event.clientY - drag.startY),
          });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onDoubleClick={(event) => {
          if (video) return;
          event.preventDefault();
          event.stopPropagation();
          if (zoom > 1.01) resetView();
          else {
            setZoom(2);
            setOffset({ x: 0, y: 0 });
          }
        }}
        style={{ cursor: !video && zoom > 1 ? "grab" : "default" }}
      >
        {video ? (
          <video
            src={src}
            controls
            autoPlay
            playsInline
            className="max-h-[calc(100vh-5.5rem)] max-w-[calc(100vw-2rem)] select-none rounded-xl shadow-2xl object-contain"
          />
        ) : (
          <img
            src={src}
            alt={alt}
            draggable={false}
            crossOrigin="anonymous"
            referrerPolicy="no-referrer"
            className="max-h-[calc(100vh-5.5rem)] max-w-[calc(100vw-2rem)] select-none object-contain transition-transform duration-75 will-change-transform"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          />
        )}
      </div>

      {!video ? (
        <p className="pointer-events-none absolute bottom-3 left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white/80 sm:flex">
          <ZoomIn size={12} />
          {t("canvas.previewHint")}
        </p>
      ) : null}
    </div>,
    document.body,
  );
}
