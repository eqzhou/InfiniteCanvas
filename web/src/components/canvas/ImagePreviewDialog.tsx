import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

export function ImagePreviewDialog({
  open,
  src,
  alt,
  onClose,
}: {
  open: boolean;
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeDismiss(open, onClose, 100);
  useLayoutEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
      className="ob-overlay bg-black/80 p-3 sm:p-6"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <img src={src} alt={alt} className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] object-contain" />
      <button
        type="button"
        title="关闭预览"
        className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-xl bg-black/55 text-white shadow-lg backdrop-blur-sm hover:bg-black/75 sm:right-5 sm:top-5"
        onClick={onClose}
      >
        <X size={20} />
      </button>
    </div>,
    document.body,
  );
}
