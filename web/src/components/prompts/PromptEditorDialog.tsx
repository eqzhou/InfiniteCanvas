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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-3 sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-editor-title"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] shadow-[var(--ob-shadow)]"
      >
        <header className="flex min-h-14 items-center border-b border-[var(--ob-line)] px-4 sm:px-5">
          <h2 id="prompt-editor-title" className="text-base font-semibold">{heading}</h2>
          <button
            type="button"
            title="关闭提示词编辑器"
            aria-label="关闭提示词编辑器"
            className="ml-auto grid h-8 w-8 place-items-center rounded-md text-[var(--ob-muted)] hover:bg-[var(--ob-accent-soft)]"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--ob-muted)]">标题</span>
            <input
              className="rounded-md border border-[var(--ob-line)] bg-transparent px-3 py-2 outline-none focus:border-[var(--ob-select)]"
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--ob-muted)]">提示词内容</span>
            <textarea
              className="min-h-56 resize-y rounded-md border border-[var(--ob-line)] bg-transparent px-3 py-2 leading-relaxed outline-none focus:border-[var(--ob-select)]"
              maxLength={20_000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[var(--ob-muted)]">标签</span>
            <input
              className="rounded-md border border-[var(--ob-line)] bg-transparent px-3 py-2 outline-none focus:border-[var(--ob-select)]"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="商品, 摄影, 海报"
            />
          </label>
          {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--ob-line)] px-4 py-3 sm:px-5">
          <button type="button" disabled={busy} className="rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm disabled:opacity-50" onClick={onClose}>
            取消
          </button>
          <button type="button" disabled={busy} className="rounded-md bg-[var(--ob-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50" onClick={submit}>
            {busy ? "保存中" : "保存提示词"}
          </button>
        </footer>
      </div>
    </div>
  );
}
