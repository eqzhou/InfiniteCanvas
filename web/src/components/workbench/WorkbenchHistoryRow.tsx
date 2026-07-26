import { useEffect, useState } from "react";
import { CornerUpLeft, Download, RefreshCw, Square, Trash2 } from "lucide-react";
import type { GenerationJob } from "@/types/board";
import { downloadStorageKey, getBlob } from "@/services/storage";
import {
  formatWorkbenchBytes,
  normalizeWorkbenchCategory,
  workbenchReferenceKeys,
} from "@/lib/workbench-history";

export type WorkbenchResultItem = {
  url?: string;
  storageKey?: string;
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

export function WorkbenchHistoryRow({ job, selected = false, onSelectedChange, onRefill, onRetry, onInsert, onDelete, onCancel }: {
  job: GenerationJob;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onRefill: () => void;
  onRetry: () => void;
  onInsert: (item: WorkbenchResultItem) => Promise<void>;
  onDelete: () => Promise<void>;
  onCancel?: () => Promise<void>;
}) {
  const items = resultItems(job);
  const referenceKeys = workbenchReferenceKeys(job);
  const category = normalizeWorkbenchCategory(job.parameters.category);
  const [inserting, setInserting] = useState<number | null>(null);
  const [inserted, setInserted] = useState<number | null>(null);
  const statusLabel =
    job.status === "succeeded" ? "成功"
      : job.status === "running" ? "进行中"
        : job.status === "failed" ? "失败"
          : job.status === "cancelled" ? "已取消"
            : job.status;
  return (
    <article className="ob-card p-4" data-generation-status={job.status} data-selected={selected ? "true" : "false"}>
      <div className="mb-3 flex items-start gap-3">
        {onSelectedChange ? (
          <label className="mt-1 flex shrink-0 items-center">
            <input
              type="checkbox"
              aria-label={`选择历史 ${job.prompt}`}
              checked={selected}
              onChange={(event) => onSelectedChange(event.target.checked)}
            />
          </label>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-[var(--ob-ink)]">{job.prompt}</div>
          <div className="mt-0.5 text-xs font-medium text-[var(--ob-muted)]">
            <span className="ob-status-dot mr-1" data-status={job.status} />
            {statusLabel} · {job.model || "默认模型"}
          </div>
          {job.kind === "image" ? (
            <span className="mt-1 inline-flex rounded-full bg-[var(--ob-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ob-accent)]">
              {category}
            </span>
          ) : null}
        </div>
        {onCancel ? (
          <button type="button" className="ob-btn-danger rounded-lg p-1.5" title="取消任务" onClick={() => void onCancel()}>
            <Square size={16} />
          </button>
        ) : (
          <>
            <button
              type="button"
              className="ob-icon-btn h-8 w-8"
              title="回填设置到表单"
              aria-label="回填设置到表单"
              onClick={onRefill}
            >
              <CornerUpLeft size={16} />
            </button>
            <button type="button" className="ob-icon-btn h-8 w-8" title="重试" onClick={onRetry}>
              <RefreshCw size={16} />
            </button>
            <button type="button" className="ob-btn-danger rounded-lg p-1.5" title="删除" onClick={() => void onDelete()}>
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>
      {job.error ? <p className="mb-2 text-xs text-[var(--ob-danger)]">{job.error}</p> : null}
      <HistoryReferencePreviews storageKeys={referenceKeys} />
      <div className="grid grid-cols-2 gap-3">
        {items.map((item, index) => (
          <div key={item.storageKey ?? item.url ?? index} className="group flex min-w-0 flex-col">
            <div className="overflow-hidden rounded-xl bg-[var(--ob-canvas)]">
              <MediaPreview item={item} video={job.kind === "video"} />
            </div>
            <p className="mt-1 text-[10px] text-[var(--ob-muted)]">{formatWorkbenchBytes(item.bytes)}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="ob-icon-btn h-8 w-8 border border-[var(--ob-line)]"
                title="下载"
                onClick={() => item.storageKey
                  ? void downloadStorageKey(item.storageKey, `${job.kind}-${index + 1}.${job.kind === "video" ? "mp4" : "png"}`)
                  : downloadURL(item.url)}
              >
                <Download size={16} />
              </button>
              <button
                type="button"
                disabled={inserting !== null}
                className="ob-btn flex-1 px-3 py-1.5 text-xs"
                onClick={() => void (async () => {
                  setInserting(index);
                  try {
                    await onInsert(item);
                    setInserted(index);
                  } finally {
                    setInserting(null);
                  }
                })()}
              >
                {inserting === index ? "插入中" : inserted === index ? "已插入" : "插入画布"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function HistoryReferencePreviews({ storageKeys }: { storageKeys: readonly string[] }) {
  if (!storageKeys.length) return null;
  return (
    <div className="mb-3 flex items-center gap-1.5 overflow-x-auto" aria-label="任务参考图">
      <span className="mr-1 shrink-0 text-[10px] font-medium text-[var(--ob-muted)]">参考</span>
      {storageKeys.slice(0, 8).map((storageKey) => <StoredReferencePreview key={storageKey} storageKey={storageKey} />)}
    </div>
  );
}

function StoredReferencePreview({ storageKey }: { storageKey: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let objectURL = "";
    void getBlob(storageKey.startsWith("media:") ? "media" : "image", storageKey).then((blob) => {
      if (!blob?.type.startsWith("image/")) return;
      objectURL = URL.createObjectURL(blob);
      setUrl(objectURL);
    });
    return () => { if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [storageKey]);
  return url
    ? <img src={url} alt="参考图" className="h-10 w-10 shrink-0 rounded-lg border border-[var(--ob-line)] object-cover" />
    : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[var(--ob-line)] text-[9px] text-[var(--ob-muted)]">媒体</span>;
}

function MediaPreview({ item, video }: { item: WorkbenchResultItem; video: boolean }) {
  const [url, setUrl] = useState(item.url);
  useEffect(() => {
    if (!item.storageKey) return;
    let objectURL = "";
    void getBlob(item.storageKey.startsWith("media:") ? "media" : "image", item.storageKey).then((blob) => {
      if (!blob) return;
      objectURL = URL.createObjectURL(blob);
      setUrl(objectURL);
    });
    return () => { if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [item.storageKey]);
  if (!url) return <div className="grid aspect-video place-items-center text-xs font-medium text-[var(--ob-muted)]">结果不可用</div>;
  return video
    ? <video src={url} controls className="aspect-video w-full object-contain" />
    : <img src={url} alt="生成结果" className="aspect-video w-full object-contain" />;
}

function downloadURL(url?: string) {
  if (!url) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openboard-result";
  anchor.click();
}
