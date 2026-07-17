import type { PromptItem } from "@/types/board";
import { X } from "lucide-react";

export function PromptDetailDialog({
  prompt,
  open,
  onClose,
  onCopy,
  onAddAsset,
  onInsert,
}: {
  prompt: PromptItem | null;
  open: boolean;
  onClose: () => void;
  onCopy: () => void;
  onAddAsset: () => void;
  onInsert?: () => void;
}) {
  if (!open || !prompt) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-detail-title"
        className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-5 shadow-[var(--ob-shadow)]"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="prompt-detail-title" className="text-lg font-semibold">{prompt.title}</h2>
            <p className="text-xs text-[var(--ob-muted)]">来源：{prompt.source}</p>
          </div>
          <button type="button" title="关闭详情" className="rounded-md p-1 text-[var(--ob-muted)]" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {prompt.coverUrl ? (
          <img
            src={prompt.coverUrl}
            alt=""
            crossOrigin="anonymous"
            referrerPolicy="no-referrer"
            className="mb-3 max-h-56 w-full rounded-md object-contain bg-[var(--ob-canvas)]"
          />
        ) : null}
        {prompt.resultUrls?.length ? (
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {prompt.resultUrls.map((url, index) => (
              <img
                key={url}
                src={url}
                alt={`结果图 ${index + 1}`}
                crossOrigin="anonymous"
                referrerPolicy="no-referrer"
                className="aspect-square w-full rounded-md bg-[var(--ob-canvas)] object-contain"
              />
            ))}
          </div>
        ) : null}
        <pre className="whitespace-pre-wrap rounded-md border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-3 text-sm leading-relaxed">
          {prompt.body}
        </pre>
        {prompt.tags.length ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {prompt.tags.map((t) => (
              <span
                key={t}
                className="rounded bg-[var(--ob-accent-soft)] px-1.5 py-0.5 text-[11px]"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm"
            onClick={onCopy}
          >
            复制提示词
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm"
            onClick={onAddAsset}
          >
            加入素材
          </button>
          {onInsert ? (
            <button
              type="button"
              className="rounded-md bg-[var(--ob-accent)] px-3 py-1.5 text-sm text-white"
              onClick={onInsert}
            >
              插入当前画布文本节点
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
