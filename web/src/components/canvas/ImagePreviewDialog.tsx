import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

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
  useLayoutEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
      className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <img src={src} alt={alt} className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] object-contain" />
      <button
        type="button"
        title="关闭预览"
        className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-md bg-black/60 text-white hover:bg-black/80"
        onClick={onClose}
      >
        <X size={20} />
      </button>
    </div>,
    document.body,
  );
}
