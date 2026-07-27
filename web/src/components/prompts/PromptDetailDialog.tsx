import type { PromptItem } from "@/types/board";
import { X } from "lucide-react";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

export function PromptDetailDialog({
  prompt,
  open,
  onClose,
  onCopy,
  onAddAsset,
  onInsert,
  onPreviewImage,
}: {
  prompt: PromptItem | null;
  open: boolean;
  onClose: () => void;
  onCopy: () => void;
  onAddAsset: () => void;
  onInsert?: () => void;
  onPreviewImage?: (src: string, alt: string) => void;
}) {
  useEscapeDismiss(open && Boolean(prompt), onClose);
  if (!open || !prompt) return null;
  return (
    <div className="ob-overlay z-[120] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-detail-title"
        className="ob-dialog max-w-2xl p-5"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="prompt-detail-title" className="text-lg font-semibold">{prompt.title}</h2>
            <p className="text-xs text-[var(--ob-muted)]">来源：{prompt.source}</p>
          </div>
          <button type="button" title="关闭详情" className="ob-btn-ghost p-1 text-[var(--ob-muted)]" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {prompt.coverUrl ? (
          <button
            type="button"
            className="mb-3 block w-full overflow-hidden rounded-md bg-[var(--ob-canvas)]"
            title="查看封面"
            aria-label={`查看封面：${prompt.title}`}
            onClick={() => onPreviewImage?.(prompt.coverUrl!, prompt.title)}
          >
            <img
              src={prompt.coverUrl}
              alt=""
              crossOrigin="anonymous"
              referrerPolicy="no-referrer"
              className="max-h-56 w-full object-contain"
            />
          </button>
        ) : null}
        {prompt.resultUrls?.length ? (
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {prompt.resultUrls.map((url, index) => (
              <button
                key={url}
                type="button"
                className="overflow-hidden rounded-md bg-[var(--ob-canvas)]"
                title={`查看结果图 ${index + 1}`}
                aria-label={`查看结果图 ${index + 1}`}
                onClick={() => onPreviewImage?.(url, `${prompt.title} · 结果图 ${index + 1}`)}
              >
                <img
                  src={url}
                  alt={`结果图 ${index + 1}`}
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                  className="aspect-square w-full object-contain"
                />
              </button>
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
            className="ob-btn text-sm"
            onClick={onCopy}
          >
            复制提示词
          </button>
          <button
            type="button"
            className="ob-btn text-sm"
            onClick={onAddAsset}
          >
            加入素材
          </button>
          {onInsert ? (
            <button
              type="button"
              className="ob-btn-primary text-sm"
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
