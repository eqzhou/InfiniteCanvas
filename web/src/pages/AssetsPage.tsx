import { useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import type { AssetItem } from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { writeTextWithFallback } from "@/lib/clipboard";
import { downloadStorageKey, uploadMedia } from "@/services/storage";
import { filenameForMimeType } from "@/lib/download-filename";
import { AssetEditorDialog, type AssetEditorValues } from "@/components/assets/AssetEditorDialog";
import { deleteAssetBlobIfUnreferenced } from "@/services/asset-lifecycle";
import { useI18n } from "@/i18n/I18nProvider";

export function AssetsPage() {
  const { t } = useI18n();
  const assets = useBoardStore((s) => s.assets);
  const setAssets = useBoardStore((s) => s.setAssets);
  const flushAssets = useBoardStore((s) => s.flushAssets);
  const insertAsset = useBoardStore((s) => s.insertAsset);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | AssetItem["kind"]>("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const pageSize = 12;

  const filtered = useMemo(() => {
    return assets.filter((a) => {
      if (kind !== "all" && a.kind !== kind) return false;
      if (!q.trim()) return true;
      const s = q.toLowerCase();
      return (
        a.title.toLowerCase().includes(s) ||
        a.tags.some((t) => t.toLowerCase().includes(s)) ||
        (a.content ?? "").toLowerCase().includes(s) ||
        (a.notes ?? "").toLowerCase().includes(s) ||
        (a.source ?? "").toLowerCase().includes(s)
      );
    });
  }, [assets, kind, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const addText = () => {
    const timestamp = nowIso();
    setCreating(true);
    setEditing({
      id: uid("asset"),
      kind: "text",
      title: t("assets.defaultTextTitle"),
      content: "",
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };

  const addMedia = async (file: File, assetKind: "image" | "video" | "audio") => {
    const uploaded = await uploadMedia(file, assetKind === "image" ? "image" : "media", {
      validateLargeImage: assetKind === "image",
    });
    const t = nowIso();
    const item: AssetItem = {
      id: uid("asset"),
      kind: assetKind,
      title: file.name,
      coverUrl: uploaded.url,
      storageKey: uploaded.storageKey,
      mimeType: uploaded.mimeType,
      tags: [],
      createdAt: t,
      updatedAt: t,
    };
    setAssets([item, ...useBoardStore.getState().assets]);
    await flushAssets();
  };

  const removeOrphanedBlob = async (storageKey: string | undefined, nextAssets: AssetItem[]) => {
    await deleteAssetBlobIfUnreferenced(
      storageKey,
      useBoardStore.getState().projects,
      nextAssets,
    );
  };

  const saveAsset = async (values: AssetEditorValues) => {
    if (!editing) return;
    if (creating) {
      const created: AssetItem = {
        ...editing,
        title: values.title,
        tags: [...values.tags],
        source: values.source || undefined,
        notes: values.notes || undefined,
        content: values.content,
        updatedAt: nowIso(),
      };
      setAssets([created, ...useBoardStore.getState().assets.filter((asset) => asset.id !== created.id)]);
      await flushAssets();
      setCreating(false);
      setEditing(null);
      return;
    }
    const replacement = values.replacement
      ? await uploadMedia(values.replacement, editing.kind === "image" ? "image" : "media", {
          validateLargeImage: editing.kind === "image",
        })
      : null;
    const latestAssets = useBoardStore.getState().assets;
    const nextAssets = latestAssets.map((asset) =>
      asset.id === editing.id
        ? {
            ...asset,
            title: values.title,
            tags: [...values.tags],
            source: values.source || undefined,
            notes: values.notes || undefined,
            content: asset.kind === "text" ? values.content : asset.content,
            coverUrl: replacement?.url ?? asset.coverUrl,
            storageKey: replacement?.storageKey ?? asset.storageKey,
            mimeType: replacement?.mimeType ?? asset.mimeType,
            updatedAt: nowIso(),
          }
        : asset,
    );
    setAssets(nextAssets);
    await flushAssets();
    if (replacement) await removeOrphanedBlob(editing.storageKey, nextAssets);
    setEditing(null);
  };

  return (
    <div className="ob-page">
      <header className="ob-page-header">
        <div className="min-w-0">
          <p className="ob-page-kicker">Library</p>
          <h1 className="ob-page-title">{t("assets.title")}</h1>
          <p className="ob-page-desc">{t("assets.description")}</p>
        </div>
      </header>

      <div className="ob-toolbar-strip">
        <input
          className="ob-field w-full sm:max-w-xs sm:flex-1"
          aria-label={t("assets.search")}
          placeholder={t("assets.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="ob-field w-auto cursor-pointer"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          aria-label={t("assets.kind")}
        >
          <option value="all">{t("common.allTypes")}</option>
          <option value="text">{t("common.text")}</option>
          <option value="image">{t("common.image")}</option>
          <option value="video">{t("common.video")}</option>
          <option value="audio">{t("common.audio")}</option>
        </select>
        <div className="ob-page-actions !ml-0 sm:ml-auto">
          <button type="button" className="ob-btn" onClick={addText}>
            {t("assets.newText")}
          </button>
          <label className="ob-btn cursor-pointer">
            {t("assets.uploadImage")}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addMedia(f, "image");
                e.currentTarget.value = "";
              }}
            />
          </label>
          <label className="ob-btn cursor-pointer">
            {t("assets.uploadVideo")}
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addMedia(file, "video");
                e.currentTarget.value = "";
              }}
            />
          </label>
          <label className="ob-btn cursor-pointer">
            {t("assets.uploadAudio")}
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addMedia(file, "audio");
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {pageItems.map((a) => (
          <article key={a.id} className="ob-card flex flex-col overflow-hidden p-4">
            {a.kind === "image" && a.coverUrl ? (
              <img
                src={a.coverUrl}
                alt={a.title}
                className="mb-3 h-40 w-full rounded-xl object-cover"
              />
            ) : null}
            {a.kind === "video" && a.coverUrl ? (
              <video
                src={a.coverUrl}
                aria-label={a.title}
                muted
                preload="metadata"
                className="mb-3 h-40 w-full rounded-xl bg-black object-contain"
              />
            ) : null}
            {a.kind === "audio" && a.coverUrl ? (
              <div className="mb-3 grid h-32 place-items-center rounded-xl bg-[var(--ob-canvas)] px-3">
                <audio src={a.coverUrl} aria-label={a.title} controls preload="none" className="w-full" />
              </div>
            ) : null}
            <div className="flex-1">
              <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 font-semibold text-[var(--ob-ink)]">{a.title}</h3>
                <span className="ob-chip shrink-0">
                  {a.kind === "text" ? t("common.text") : a.kind === "image" ? t("common.image") : a.kind === "video" ? t("common.video") : t("common.audio")}
                </span>
              </div>
              {a.source ? <p className="mt-0.5 truncate text-xs text-[var(--ob-muted)]">{a.source}</p> : null}
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--ob-muted)]">
                {a.kind === "text" ? a.content : a.mimeType}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--ob-line)] pt-3 text-sm">
              <button
                type="button"
                className="ob-btn"
                disabled={insertingId === a.id}
                aria-busy={insertingId === a.id}
                onClick={() => {
                  const project = useBoardStore.getState().getActive();
                  if (!project) {
                    alert(t("assets.openCanvasFirst"));
                    return;
                  }
                  setInsertingId(a.id);
                  // Stay on the library page; busy state ends only after persistNow.
                  void insertAsset(a.id, {
                    x: 80 + Math.random() * 120,
                    y: 80 + Math.random() * 120,
                  }).catch((cause) => {
                    alert(cause instanceof Error ? cause.message : String(cause));
                  }).finally(() => setInsertingId(null));
                }}
              >
                {insertingId === a.id ? t("assets.inserting") : t("assets.insertCanvas")}
              </button>
              {a.kind === "text" ? (
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => void writeTextWithFallback(a.content ?? "").catch(() => undefined)}
                >
                  {t("common.copy")}
                </button>
              ) : null}
              {a.kind !== "text" && a.storageKey ? (
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() =>
                    void downloadStorageKey(
                      a.storageKey!,
                      filenameForMimeType(a.title || a.id, a.mimeType, a.kind === "image" ? "png" : a.kind === "video" ? "mp4" : "mp3"),
                    )
                  }
                >
                  {t("common.download")}
                </button>
              ) : null}
              <button
                type="button"
                className="ob-btn"
                onClick={() => {
                  setCreating(false);
                  setEditing(a);
                }}
              >
                {t("common.edit")}
              </button>
              <button
                type="button"
                className="ob-btn-danger ml-auto rounded-lg px-2.5 py-1.5 text-sm font-medium"
                onClick={() => {
                  if (!window.confirm(t("assets.confirmDelete", { title: a.title }))) return;
                  void (async () => {
                    const nextAssets = structuredClone(
                      useBoardStore.getState().assets.filter((item) => item.id !== a.id),
                    );
                    setAssets(nextAssets);
                    await flushAssets();
                    await removeOrphanedBlob(a.storageKey, nextAssets);
                    // Keep pagination valid after the last item on a page is removed.
                    setPage((current) => {
                      const totalPages = Math.max(1, Math.ceil(nextAssets.length / pageSize));
                      return Math.min(current, totalPages);
                    });
                  })();
                }}
              >
                {t("common.delete")}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!filtered.length ? (
        <div className="ob-empty mt-8">
          <span className="ob-empty-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
          </span>
          <p className="ob-empty-title">{t("assets.empty")}</p>
          <p className="ob-empty-desc">{t("assets.emptyDescription")}</p>
        </div>
      ) : (
        <div className="mt-8 flex items-center justify-center gap-4 text-sm">
          <button
            type="button"
            className="ob-btn"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("common.previousPage")}
          </button>
          <span className="ob-chip px-4 py-1.5 text-xs">
            {t("common.pageTotal", { page, pages: totalPages, total: filtered.length })}
          </span>
          <button
            type="button"
            className="ob-btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            {t("common.nextPage")}
          </button>
        </div>
      )}
      <AssetEditorDialog
        asset={editing}
        mode={creating ? "create" : "edit"}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={saveAsset}
      />
    </div>
  );
}
