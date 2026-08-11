import { useEffect, useRef } from "react";
import { CheckSquare, Eye, ImagePlus, Sparkles, Trash2, X } from "lucide-react";

import type { DirectorCaptureRecord } from "@/services/director-capture-store";
import { useI18n } from "@/i18n/I18nProvider";

export type DirectorCaptureView = {
  record: DirectorCaptureRecord;
  url: string;
};

export function DirectorCaptureTray({
  captures,
  selectedIds,
  busy,
  previewId,
  onCapture,
  onToggle,
  onSelectAll,
  onDeleteSelected,
  onClear,
  onSendSelected,
  onGenerateSelected,
  onPreview,
}: {
  captures: DirectorCaptureView[];
  selectedIds: ReadonlySet<string>;
  busy: boolean;
  previewId: string | null;
  onCapture: () => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onDeleteSelected: () => void;
  onClear: () => void;
  onSendSelected: () => void;
  onGenerateSelected: () => void;
  onPreview: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const synchronized = true;
  const preview = captures.find((capture) => capture.record.id === previewId);
  const selectedCapture = selectedIds.size === 1
    ? captures.find((capture) => selectedIds.has(capture.record.id))
    : undefined;
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!preview) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previewCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onPreview(null);
      } else if (event.key === "Tab") {
        event.preventDefault();
        previewCloseRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [onPreview, preview]);
  return (
    <section
      aria-label={t("director.tray")}
      className="absolute bottom-3 left-1/2 z-10 w-[min(780px,calc(100%-24px))] -translate-x-1/2 rounded-xl border border-white/10 bg-black/75 p-2 backdrop-blur"
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className="rounded-lg bg-[#f0f269] px-4 py-2 text-xs font-semibold text-black disabled:opacity-50" disabled={busy} onClick={onCapture}>
          {busy ? t("director.capturing") : t("director.captureCurrent")}
        </button>
        <span className="mr-auto text-[11px] text-slate-400">{t(synchronized ? "director.captureSynchronized" : "director.captureLocal")} · {captures.length}</span>
        <button type="button" className="rounded bg-white/10 px-2 py-1.5 text-[11px] disabled:opacity-40" disabled={!captures.length || busy} onClick={onSelectAll}><CheckSquare size={12} className="mr-1 inline" />{t(selectedIds.size === captures.length ? "director.deselectAll" : "director.selectAll")}</button>
        <button type="button" className="rounded bg-white/10 px-2 py-1.5 text-[11px] disabled:opacity-40" disabled={!selectedIds.size || busy} onClick={onSendSelected}><ImagePlus size={12} className="mr-1 inline" />{t("director.sendToCanvas")}</button>
        <button
          type="button"
          className="rounded bg-[#f0f269] px-2 py-1.5 text-[11px] font-semibold text-black disabled:opacity-40"
          disabled={selectedIds.size !== 1 || !selectedCapture?.record.shot || busy}
          title={selectedIds.size > 1
            ? t("director.generateShotRequiresOne")
            : selectedCapture && !selectedCapture.record.shot
              ? t("director.generateShotMissingInfo")
              : t("director.generateShotReady")}
          onClick={onGenerateSelected}
        ><Sparkles size={12} className="mr-1 inline" />{t("director.generateShot")}</button>
        <button type="button" className="rounded bg-white/10 px-2 py-1.5 text-[11px] disabled:opacity-40" disabled={!selectedIds.size || busy} onClick={onDeleteSelected}><Trash2 size={12} className="mr-1 inline" />{t("director.deleteSelected")}</button>
        <button type="button" className="rounded bg-white/10 px-2 py-1.5 text-[11px] disabled:opacity-40" disabled={!captures.length || busy} onClick={onClear}>{t("director.clearAll")}</button>
      </div>
      {captures.length ? (
        <div className="flex max-h-32 gap-2 overflow-x-auto" role="list" aria-label={t(synchronized ? "director.captureListSynchronized" : "director.captureListLocal")}>
          {captures.map(({ record, url }) => (
            <article key={record.id} role="listitem" className={`relative w-36 shrink-0 rounded border p-1 ${selectedIds.has(record.id) ? "border-[#f0f269] bg-[#f0f269]/10" : "border-white/10 bg-white/5"}`}>
              <label className="absolute left-2 top-2 z-10 rounded bg-black/65 p-1">
                <input aria-label={t("director.selectCapture", { name: record.cameraName })} type="checkbox" checked={selectedIds.has(record.id)} onChange={() => onToggle(record.id)} />
              </label>
              <img loading="lazy" decoding="async" src={url} alt={t("director.captureAlt", { name: record.cameraName })} className="h-20 w-full rounded object-cover" />
              <div className="mt-1 flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-[10px]">{record.cameraName}</span>
                <button type="button" className="rounded p-1 hover:bg-white/10" aria-label={t("director.previewCapture", { name: record.cameraName })} onClick={() => onPreview(record.id)}><Eye size={12} /></button>
              </div>
            </article>
          ))}
        </div>
      ) : <p className="py-2 text-center text-[11px] text-slate-500">{t(synchronized ? "director.captureSyncedInfo" : "director.captureLocalInfo")}</p>}

      {preview ? (
        <div role="dialog" aria-modal="true" aria-label={t("director.capturePreview")} className="fixed inset-0 z-[190] grid place-items-center bg-black/85 p-8">
          <button ref={previewCloseRef} type="button" aria-label={t("director.closeCapturePreview")} className="absolute right-5 top-5 rounded bg-white/10 p-2" onClick={() => onPreview(null)}><X size={18} /></button>
          <img src={preview.url} alt={t("director.capturePreviewAlt", { name: preview.record.cameraName })} className="max-h-full max-w-full object-contain" />
        </div>
      ) : null}
    </section>
  );
}
