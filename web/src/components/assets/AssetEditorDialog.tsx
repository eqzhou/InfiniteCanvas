import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { AssetItem } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";

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
  mode = "edit",
  onClose,
  onSave,
}: {
  asset: AssetItem | null;
  mode?: "create" | "edit";
  onClose: () => void;
  onSave: (values: AssetEditorValues) => Promise<void>;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const [content, setContent] = useState("");
  const [replacement, setReplacement] = useState<File | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeDismiss(Boolean(asset) && !busy, onClose);

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
    <div className="ob-overlay z-[120] p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-editor-title"
        className="ob-dialog max-w-xl p-5"
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
          <h2 id="asset-editor-title" className="font-semibold">{mode === "create" ? t("assetEditor.create") : t("assetEditor.edit")}</h2>
          <button type="button" title={t("assetEditor.close")} className="ob-btn-ghost ml-auto p-1" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span>{t("assetEditor.title")}</span>
            <input id="asset-title" aria-label={t("assetEditor.title")} className="ob-field" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            <span>{t("assetEditor.source")}</span>
            <input aria-label={t("assetEditor.source")} className="ob-field" value={source} onChange={(event) => setSource(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            {t("assetEditor.tags")}
            <input className="ob-field" value={tags} onChange={(event) => setTags(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            {t("assetEditor.notes")}
            <textarea className="ob-field min-h-20 resize-y" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          {asset.kind === "text" ? (
            <label className="grid gap-1 text-sm sm:col-span-2">
              <span>{t("assetEditor.content")}</span>
              <textarea aria-label={t("assetEditor.content")} className="ob-field min-h-40 resize-y" value={content} onChange={(event) => setContent(event.target.value)} />
            </label>
          ) : (
            <label className="grid gap-1 text-sm sm:col-span-2">
              {t(asset.kind === "image" ? "assetEditor.replaceImage" : asset.kind === "video" ? "assetEditor.replaceVideo" : "assetEditor.replaceAudio")}
              <input type="file" accept={`${asset.kind}/*`} onChange={(event) => setReplacement(event.target.files?.[0])} />
            </label>
          )}
        </div>
        {error ? <p role="alert" className="mt-3 text-sm text-[var(--ob-danger)]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ob-btn text-sm" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" disabled={busy || !title.trim()} className="ob-btn-primary text-sm disabled:opacity-50">
            {busy ? t("assetEditor.saving") : t("assetEditor.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
