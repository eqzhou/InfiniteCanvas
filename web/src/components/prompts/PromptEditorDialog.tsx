import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { PromptItem } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

export type PromptEditorValues = {
  title: string;
  body: string;
  tags: string[];
};

export function PromptEditorDialog({
  open,
  mode,
  prompt,
  onClose,
  onSave,
}: {
  open: boolean;
  mode: "create" | "edit";
  prompt: PromptItem | null;
  onClose: () => void;
  onSave: (values: PromptEditorValues) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(prompt?.title ?? "");
    setBody(prompt?.body ?? "");
    setTags(prompt?.tags.join(", ") ?? "");
    setError(null);
    setBusy(false);
  }, [open, prompt]);

  useEscapeDismiss(open && !busy, onClose);
  if (!open) return null;

  const heading = mode === "edit" ? "编辑提示词" : "新建提示词";
  const submit = () => {
    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();
    if (!normalizedTitle) {
      setError("请输入标题");
      return;
    }
    if (!normalizedBody) {
      setError("请输入提示词内容");
      return;
    }
    const normalizedTags = Array.from(new Set(
      tags
        .split(/[,，\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    )).slice(0, 20);
    setBusy(true);
    setError(null);
    void Promise.resolve().then(() => onSave({
      title: normalizedTitle.slice(0, 120),
      body: normalizedBody.slice(0, 20_000),
      tags: normalizedTags.map((tag) => tag.slice(0, 40)),
    })).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="ob-overlay z-[120] p-3 sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-editor-title"
        className="ob-dialog flex flex-col max-w-2xl"
      >
        <header className="ob-dialog-header px-4 sm:px-5">
          <h2 id="prompt-editor-title" className="text-base font-semibold">{heading}</h2>
          <button
            type="button"
            title="关闭提示词编辑器"
            aria-label="关闭提示词编辑器"
            className="ob-btn-ghost ml-auto p-1"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <div className="ob-dialog-body flex-1 space-y-4 min-h-0 overflow-y-auto p-4 sm:p-5">
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--ob-muted)]">标题</span>
            <input
              className="ob-field"
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--ob-muted)]">提示词内容</span>
            <textarea
              className="ob-field min-h-56 resize-y"
              maxLength={20_000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--ob-muted)]">标签</span>
            <input
              className="ob-field"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="商品, 摄影, 海报"
            />
          </label>
          {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
        </div>
        <footer className="ob-dialog-footer gap-2 px-4 py-3 sm:px-5">
          <button type="button" disabled={busy} className="ob-btn text-sm disabled:opacity-50" onClick={onClose}>
            取消
          </button>
          <button type="button" disabled={busy} className="ob-btn-primary text-sm disabled:opacity-50" onClick={submit}>
            {busy ? "保存中" : "保存提示词"}
          </button>
        </footer>
      </div>
    </div>
  );
}
