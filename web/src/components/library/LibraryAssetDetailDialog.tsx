import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { LibraryAsset } from "@/services/library-assets";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

const KIND_LABELS: Record<LibraryAsset["kind"], string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
};

/** Read-only detail view for a server library asset. */
export function LibraryAssetDetailDialog({
  asset,
  onClose,
}: {
  asset: LibraryAsset | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = asset !== null;
  useEscapeDismiss(open, onClose, 100);
  useLayoutEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  if (!asset) return null;
  const media = asset.coverUrl || asset.content || "";
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="素材详情"
      tabIndex={-1}
      className="ob-overlay bg-black/60 p-3 sm:p-6"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="ob-surface-glass flex max-h-[85vh] w-full max-w-2xl flex-col overflow-auto p-5 shadow-[var(--ob-elev-2)]">
        <header className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{asset.title}</h2>
            <p className="mt-1 text-xs text-[var(--ob-muted)]">
              {KIND_LABELS[asset.kind]}
              {asset.source ? ` · ${asset.source}` : ""}
            </p>
          </div>
          <button type="button" className="ob-icon-btn" aria-label="关闭素材详情" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        {asset.kind === "image" && media ? (
          <img src={media} alt={asset.title} className="mb-3 max-h-[45vh] w-full rounded-lg object-contain" />
        ) : asset.kind === "video" && media ? (
          <video src={media} className="mb-3 max-h-[45vh] w-full rounded-lg" controls preload="metadata" />
        ) : asset.kind === "audio" && media ? (
          <audio src={media} className="mb-3 w-full" controls preload="none" />
        ) : null}

        {asset.kind === "text" && asset.content ? (
          <pre className="mb-3 whitespace-pre-wrap break-words rounded-lg bg-[var(--ob-canvas)] p-3 text-sm leading-relaxed">{asset.content}</pre>
        ) : null}

        {asset.tags.length ? (
          <div className="mb-3 flex flex-wrap gap-1">
            {asset.tags.map((tag) => <span key={tag} className="ob-chip">{tag}</span>)}
          </div>
        ) : null}

        {asset.notes ? (
          <p className="text-sm text-[var(--ob-muted)]">{asset.notes}</p>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
