import { useEffect, useState } from "react";
import {
  AlertCircle,
  CornerUpLeft,
  Download,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Video as VideoIcon,
} from "lucide-react";
import type { GenerationJob } from "@/types/board";
import { downloadStorageKey, getBlob } from "@/services/storage";
import {
  formatWorkbenchBytes,
  normalizeWorkbenchCategory,
  workbenchCardMedia,
  workbenchReferenceKeys,
} from "@/lib/workbench-history";
import { useI18n } from "@/i18n/I18nProvider";
import { ImagePreviewDialog } from "@/components/canvas/ImagePreviewDialog";
import { createServerBlobDisplayUrls } from "@/services/server-storage";
import { MediaView } from "@/components/common/MediaView";

export type WorkbenchResultItem = {
  url?: string;
  storageKey?: string;
  thumbnailUrl?: string;
  thumbnailStorageKey?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
};

function resultItems(job: GenerationJob): WorkbenchResultItem[] {
  return Array.isArray(job.result.items)
    ? job.result.items.filter((item): item is WorkbenchResultItem => Boolean(item && typeof item === "object"))
    : [];
}

async function resolveHistoryMediaUrl(
  kind: "image" | "media",
  storageKey: string,
  fallback = "",
): Promise<{ url: string; objectUrl?: string }> {
  try {
    const displayUrls = await createServerBlobDisplayUrls([storageKey]);
    const displayUrl = displayUrls.get(storageKey);
    if (displayUrl) return { url: displayUrl };
  } catch {
    // Fall back to the durable Blob endpoint for local/test storage setups.
  }
  try {
    const blob = await getBlob(kind, storageKey);
    if (blob) {
      const objectUrl = URL.createObjectURL(blob);
      return { url: objectUrl, objectUrl };
    }
  } catch {
    // A stale history item should remain visible as unavailable, not reject the page.
  }
  return { url: fallback };
}

export function WorkbenchHistoryRow({
  job,
  selected = false,
  onSelectedChange,
  onRefill,
  onRetry,
  onInsert,
  onDelete,
  onCancel,
}: {
  job: GenerationJob;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onRefill: () => void;
  onRetry: () => void;
  onInsert: (item: WorkbenchResultItem) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const items = resultItems(job);
  const referenceKeys = workbenchReferenceKeys(job);
  const category = normalizeWorkbenchCategory(job.parameters.category);
  const [activeIndex, setActiveIndex] = useState(0);
  const [inserting, setInserting] = useState<number | null>(null);
  const [inserted, setInserted] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const activeItem = items[activeIndex] ?? items[0];
  const cardMedia = workbenchCardMedia(activeItem ?? {});
  const [activeMediaUrl, setActiveMediaUrl] = useState(cardMedia.fullUrl);
  const [activePreviewUrl, setActivePreviewUrl] = useState(cardMedia.cardUrl);

  useEffect(() => {
    let cancelled = false;
    let objectURL = "";
    const media = workbenchCardMedia(activeItem ?? {});
    setActiveMediaUrl(media.fullUrl);
    setActivePreviewUrl(media.cardUrl);
    const cardKey = media.cardKey ?? (media.hasPreview ? undefined : media.fullKey);
    if (!cardKey) return;
    void resolveHistoryMediaUrl(
      cardKey.startsWith("media:") ? "media" : "image",
      cardKey,
      media.hasPreview ? media.cardUrl : media.fullUrl,
    ).then((resolved) => {
      if (cancelled) {
        if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl);
        return;
      }
      objectURL = resolved.objectUrl ?? "";
      if (media.hasPreview) setActivePreviewUrl(resolved.url);
      else setActiveMediaUrl(resolved.url);
    });
    return () => {
      cancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [job.id, activeItem?.storageKey, activeItem?.thumbnailStorageKey, activeItem?.thumbnailUrl, activeItem?.url]);

  useEffect(() => {
    if (!previewOpen) return;
    const fullKey = activeItem?.storageKey;
    if (!fullKey) return;
    let cancelled = false;
    let objectURL = "";
    void resolveHistoryMediaUrl(
      fullKey.startsWith("media:") ? "media" : "image",
      fullKey,
      activeItem?.url ?? "",
    ).then((resolved) => {
      if (cancelled) {
        if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl);
        return;
      }
      objectURL = resolved.objectUrl ?? "";
      setActiveMediaUrl(resolved.url);
    });
    return () => {
      cancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [activeItem?.storageKey, activeItem?.url, previewOpen]);

  const statusLabel =
    job.status === "succeeded"
      ? t("tasks.succeeded")
      : job.status === "running"
        ? t("tasks.running")
        : job.status === "failed"
          ? t("tasks.failed")
          : job.status === "cancelled"
            ? t("tasks.cancelled")
            : job.status;

  return (
    <article
      className="ob-card group relative flex flex-col overflow-hidden rounded-2xl border border-[var(--ob-line)]/80 bg-[var(--ob-panel)] shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-[color-mix(in_srgb,var(--ob-accent)_35%,var(--ob-line))]"
      data-generation-status={job.status}
      data-selected={selected ? "true" : "false"}
    >
      {/* Top Hero Thumbnail Media Container */}
      <div
        className={`relative w-full overflow-hidden bg-[var(--ob-canvas)] ${
          job.kind === "video" ? "aspect-video" : "aspect-square"
        }`}
      >
        {items.length > 0 && (activePreviewUrl || activeMediaUrl) ? (
          <button
            type="button"
            className="h-full w-full"
            aria-label={t("history.openPreview")}
            onClick={() => setPreviewOpen(true)}
          >
            <MediaView
              kind={job.kind === "video" ? "video" : "image"}
              src={activeMediaUrl}
              previewSrc={cardMedia.hasPreview && activePreviewUrl ? activePreviewUrl : undefined}
              alt=""
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          </button>
        ) : job.status === "running" || job.status === "queued" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-[var(--ob-accent)]">
            <Loader2 size={24} className="animate-spin" />
            <span className="text-xs font-semibold">{statusLabel}</span>
          </div>
        ) : job.status === "failed" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-[var(--ob-danger)]">
            <AlertCircle size={24} />
            <span className="text-xs font-semibold line-clamp-2">{job.error || statusLabel}</span>
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[var(--ob-muted)]">
            {job.kind === "video" ? <VideoIcon size={24} /> : <ImageIcon size={24} />}
          </div>
        )}

        {/* Top Badges & Select Overlay */}
        <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between p-2 pointer-events-none">
          <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto">
            {onSelectedChange ? (
              <label
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg bg-black/60 backdrop-blur-md transition-colors hover:bg-black/80"
                onClick={(event) => event.stopPropagation()}
              >
                <input
                  type="checkbox"
                  aria-label={t("history.select", { prompt: job.prompt })}
                  checked={selected}
                  className="rounded text-[var(--ob-accent)] focus:ring-0"
                  onChange={(event) => onSelectedChange(event.target.checked)}
                />
              </label>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-lg bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-md">
              <span className="ob-status-dot h-1.5 w-1.5" data-status={job.status} />
              {statusLabel}
            </span>
          </div>

          <div className="flex items-center gap-1 pointer-events-auto">
            {onCancel ? (
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-lg bg-black/60 text-white backdrop-blur-md transition-colors hover:bg-[var(--ob-danger)]"
                title={t("history.cancel")}
                onClick={(e) => {
                  e.stopPropagation();
                  void onCancel();
                }}
              >
                <Square size={12} />
              </button>
            ) : null}
          </div>
        </div>

        {/* Multi-item variation pills */}
        {items.length > 1 ? (
          <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-lg bg-black/60 px-1.5 py-0.5 backdrop-blur-md">
            {items.map((_, index) => (
              <button
                key={index}
                type="button"
                className={`h-4 min-w-4 rounded px-1 text-[9px] font-bold transition-all ${
                  activeIndex === index
                    ? "bg-[var(--ob-accent)] text-white shadow-xs"
                    : "text-white/80 hover:bg-white/20"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveIndex(index);
                }}
              >
                {index + 1}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Body Details Area */}
      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-2 text-xs font-semibold leading-relaxed text-[var(--ob-ink)]" title={job.prompt}>
          {job.prompt || (job.kind === "video" ? t("workbench.videoPrompt") : t("workbench.imagePrompt"))}
        </p>

        {job.error ? (
          <p className="mt-1.5 rounded-lg bg-[color-mix(in_srgb,var(--ob-danger)_10%,transparent)] px-2 py-1 text-[11px] font-medium text-[var(--ob-danger)] line-clamp-2">
            {job.error}
          </p>
        ) : null}

        {/* References */}
        <HistoryReferencePreviews storageKeys={referenceKeys} />

        {/* Micro Meta Line */}
        <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-[10px] text-[var(--ob-muted)]">
          <span className="truncate font-medium">{job.model || t("history.defaultModel")}</span>
          {category ? (
            <span className="shrink-0 rounded-full bg-[var(--ob-surface-2)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--ob-ink)]">
              {category}
            </span>
          ) : activeItem?.bytes ? (
            <span className="shrink-0">{formatWorkbenchBytes(activeItem.bytes)}</span>
          ) : null}
        </div>

        {/* Inline Action Bar */}
        <div className="mt-2.5 flex items-center gap-1 border-t border-[var(--ob-line)]/60 pt-2">
          {activeItem ? (
            <button
              type="button"
              disabled={inserting !== null}
              className="ob-btn ob-btn-sm flex-1 justify-center rounded-lg px-2 py-1 text-[11px] font-semibold"
              onClick={() => void (async () => {
                setInserting(activeIndex);
                try {
                  await onInsert(activeItem);
                  setInserted(activeIndex);
                } finally {
                  setInserting(null);
                }
              })()}
            >
              <Plus size={13} />
              {inserting === activeIndex ? t("history.inserting") : inserted === activeIndex ? t("history.inserted") : t("history.insertCanvas")}
            </button>
          ) : null}

          {activeItem ? (
            <button
              type="button"
              className="ob-icon-btn h-7 w-7 rounded-lg"
              title={t("history.download")}
              aria-label={t("history.download")}
              onClick={() =>
                activeItem.storageKey
                  ? void downloadStorageKey(activeItem.storageKey, `${job.kind}-${activeIndex + 1}.${job.kind === "video" ? "mp4" : "png"}`)
                  : downloadURL(activeItem.url)
              }
            >
              <Download size={13} />
            </button>
          ) : null}

          <button
            type="button"
            className="ob-icon-btn h-7 w-7 rounded-lg"
            title={t("history.refill")}
            aria-label={t("history.refill")}
            onClick={onRefill}
          >
            <CornerUpLeft size={13} />
          </button>
          <button
            type="button"
            className="ob-icon-btn h-7 w-7 rounded-lg"
            title={t("history.retry")}
            aria-label={t("history.retry")}
            onClick={onRetry}
          >
            <RefreshCw size={13} />
          </button>
          {onDelete ? (
            <button
              type="button"
              className="ob-icon-btn h-7 w-7 rounded-lg text-[var(--ob-danger)] hover:bg-[color-mix(in_srgb,var(--ob-danger)_12%,transparent)]"
              title={t("history.delete")}
              aria-label={t("history.delete")}
              onClick={() => void onDelete()}
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {previewOpen && activeMediaUrl ? (
        <ImagePreviewDialog
          open={previewOpen}
          src={activeMediaUrl}
          alt={job.prompt || (job.kind === "video" ? t("workbench.videoPrompt") : t("workbench.imagePrompt"))}
          video={job.kind === "video"}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </article>
  );
}

function HistoryReferencePreviews({ storageKeys }: { storageKeys: readonly string[] }) {
  const { t } = useI18n();
  if (!storageKeys.length) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1 overflow-x-auto" aria-label={t("history.references")}>
      {storageKeys.slice(0, 4).map((storageKey) => (
        <StoredReferencePreview key={storageKey} storageKey={storageKey} />
      ))}
      {storageKeys.length > 4 ? (
        <span className="text-[9px] text-[var(--ob-muted)]">+{storageKeys.length - 4}</span>
      ) : null}
    </div>
  );
}

function StoredReferencePreview({ storageKey }: { storageKey: string }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  useEffect(() => {
    let cancelled = false;
    let objectURL = "";
    setUrl("");
    void resolveHistoryMediaUrl(
      storageKey.startsWith("media:") ? "media" : "image",
      storageKey,
    ).then((resolved) => {
      if (cancelled) {
        if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl);
        return;
      }
      objectURL = resolved.objectUrl ?? "";
      setUrl(resolved.url);
    });
    return () => {
      cancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [storageKey]);
  return url ? (
    <img
      src={url}
      alt={t("history.referenceImage")}
      loading="lazy"
      onError={() => setUrl("")}
      className="h-6 w-6 shrink-0 rounded-md border border-[var(--ob-line)] object-cover"
    />
  ) : (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-[var(--ob-line)] text-[8px] text-[var(--ob-muted)]">
      {t("history.media")}
    </span>
  );
}

function downloadURL(url?: string) {
  if (!url) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openboard-result";
  anchor.click();
}
