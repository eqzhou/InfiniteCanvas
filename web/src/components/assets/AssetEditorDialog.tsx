import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { AssetItem } from "@/types/board";

export type AssetEditorValues = {
  title: string;
  tags: string[];
  source: string;
  notes: string;
  content: string;
  replacement?: File;
};

export function AssetEditorDialog({
  asset,
  onClose,
  onSave,
}: {
  asset: AssetItem | null;
  onClose: () => void;
  onSave: (values: AssetEditorValues) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const [content, setContent] = useState("");
  const [replacement, setReplacement] = useState<File | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!asset) return;
    setTitle(asset.title);
    setTags(asset.tags.join(", "));
    setSource(asset.source ?? "");
    setNotes(asset.notes ?? "");
    setContent(asset.content ?? "");
    setReplacement(undefined);
    setError(null);
  }, [asset]);

  if (!asset) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-editor-title"
        className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-5 shadow-[var(--ob-shadow)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || busy) return;
          setBusy(true);
          setError(null);
          void onSave({
            title: title.trim(),
            tags: tags.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
            source: source.trim(),
            notes: notes.trim(),
            content,
            replacement,
          }).catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          }).finally(() => setBusy(false));
        }}
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 id="asset-editor-title" className="font-semibold">编辑素材</h2>
          <button type="button" title="关闭编辑" className="ml-auto rounded-md p-1" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            标题
            <input className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            来源
            <input className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5" value={source} onChange={(event) => setSource(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            标签
            <input className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5" value={tags} onChange={(event) => setTags(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            备注
            <textarea className="min-h-20 resize-y rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          {asset.kind === "text" ? (
            <label className="grid gap-1 text-sm sm:col-span-2">
              内容
              <textarea className="min-h-40 resize-y rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5" value={content} onChange={(event) => setContent(event.target.value)} />
            </label>
          ) : (
            <label className="grid gap-1 text-sm sm:col-span-2">
              替换图片
              <input type="file" accept="image/*" onChange={(event) => setReplacement(event.target.files?.[0])} />
            </label>
          )}
        </div>
        {error ? <p role="alert" className="mt-3 text-sm text-[var(--ob-danger)]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm" onClick={onClose}>取消</button>
          <button type="submit" disabled={busy || !title.trim()} className="rounded-md bg-[var(--ob-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {busy ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
