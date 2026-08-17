import { useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import type { AssetItem } from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { writeTextWithFallback } from "@/lib/clipboard";
import { downloadStorageKey } from "@/services/storage";
import { uploadDisplayMedia } from "@/services/media-preview";
import { MediaView } from "@/components/common/MediaView";
import { filenameForMimeType } from "@/lib/download-filename";
import { AssetEditorDialog, type AssetEditorValues } from "@/components/assets/AssetEditorDialog";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { deleteAssetBlobIfUnreferenced } from "@/services/asset-lifecycle";
import { useI18n } from "@/i18n/I18nProvider";
import { PageSkeleton } from "@/components/layout/PageSkeleton";
import { WorkspaceLoadError } from "@/components/layout/WorkspaceLoadError";
import { useLazyAssets } from "@/hooks/use-lazy-workspace";
import {
  Copy,
  Download,
  Edit3,
  FileText,
  Film,
  FolderHeart,
  Image as ImageIcon,
  Music,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

export function AssetsPage() {
  const { t } = useI18n();
  const assets = useBoardStore((s) => s.assets);
  const { assetsState, assetsError, loadAssetsOnDemand } = useLazyAssets();
  const setAssets = useBoardStore((s) => s.setAssets);
  const flushAssets = useBoardStore((s) => s.flushAssets);
  const insertAsset = useBoardStore((s) => s.insertAsset);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | AssetItem["kind"]>("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AssetItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    try {
      setError(null);
      const uploaded = await uploadDisplayMedia(file, assetKind === "image" ? "image" : "media", {
        validateLargeImage: assetKind === "image",
        previewKind: assetKind === "audio" ? undefined : assetKind,
      });
      const t = nowIso();
      const item: AssetItem = {
        id: uid("asset"),
        kind: assetKind,
        title: file.name,
        coverUrl: uploaded.url,
        storageKey: uploaded.storageKey,
        thumbnailStorageKey: uploaded.thumbnailStorageKey,
        thumbnailUrl: uploaded.thumbnailUrl,
        mimeType: uploaded.mimeType,
        tags: [],
        createdAt: t,
        updatedAt: t,
      };
      setAssets([item, ...useBoardStore.getState().assets]);
      await flushAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
    try {
      setError(null);
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
        ? await uploadDisplayMedia(values.replacement, editing.kind === "image" ? "image" : "media", {
            validateLargeImage: editing.kind === "image",
            previewKind: editing.kind === "audio" ? undefined : editing.kind === "video" ? "video" : editing.kind === "image" ? "image" : undefined,
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
              updatedAt: nowIso(),
              ...(replacement
                ? {
                    coverUrl: replacement.url,
                    storageKey: replacement.storageKey,
                    thumbnailStorageKey: replacement.thumbnailStorageKey,
                    thumbnailUrl: replacement.thumbnailUrl,
                    mimeType: replacement.mimeType,
                  }
                : {}),
            }
          : asset,
      );
      setAssets(nextAssets);
      await flushAssets();
      if (replacement) {
        await removeOrphanedBlob(editing.storageKey, nextAssets);
        await removeOrphanedBlob(editing.thumbnailStorageKey, nextAssets);
      }
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const executeDelete = async (a: AssetItem) => {
    setDeletingId(a.id);
    setError(null);
    try {
      const nextAssets = structuredClone(
        useBoardStore.getState().assets.filter((item) => item.id !== a.id),
      );
      setAssets(nextAssets);
      await flushAssets();
      await removeOrphanedBlob(a.storageKey, nextAssets);
      await removeOrphanedBlob(a.thumbnailStorageKey, nextAssets);
      setPage((current) => {
        const total = Math.max(1, Math.ceil(nextAssets.length / pageSize));
        return Math.min(current, total);
      });
      setPendingDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingId(null);
    }
  };

  if (assetsState === "error" && !assets.length) {
    return (
      <WorkspaceLoadError
        message={t("workspace.loadFailed", { message: assetsError ?? error ?? "" })}
        onRetry={() => { setError(null); void loadAssetsOnDemand().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}
      />
    );
  }
  if (assetsState !== "loaded" && !assets.length) return <PageSkeleton />;

  return (
    <div className="ob-page ob-view-fade-in pb-12">
      <header className="ob-page-header">
        <div className="min-w-0">
          <span className="ob-page-kicker"><FolderHeart size={13} aria-hidden />{t("nav.assets")}</span>
          <h1 className="ob-page-title">{t("assets.title")}</h1>
          <p className="ob-page-desc">{t("assets.description")}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="ob-chip text-xs text-[var(--ob-muted)]">
            {t("common.pageTotal", { page, pages: totalPages, total: assets.length })}
          </span>
        </div>
      </header>

      {error ? (
        <div role="alert" className="ob-banner mb-4 rounded-xl" data-tone="danger">
          {error}
        </div>
      ) : null}

      <div className="ob-toolbar-strip mb-5 flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ob-muted)]" aria-hidden />
          <input
            className="ob-field pl-8"
            aria-label={t("assets.search")}
            placeholder={t("assets.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
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
        <div className="ob-page-actions !ml-0 sm:ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className="ob-btn" onClick={addText}>
            <FileText size={14} aria-hidden />
            {t("assets.newText")}
          </button>
          <label className="ob-btn cursor-pointer">
            <ImageIcon size={14} aria-hidden />
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
            <Film size={14} aria-hidden />
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
            <Music size={14} aria-hidden />
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
          <article key={a.id} className="ob-card group flex flex-col overflow-hidden p-4 transition-all hover:shadow-[var(--ob-elev-2)]">
            {a.kind === "image" && (a.thumbnailUrl || a.coverUrl) ? (
              <div className="mb-3 overflow-hidden rounded-xl bg-[var(--ob-surface-2)]">
                <MediaView
                  kind="image"
                  src={a.coverUrl}
                  previewSrc={a.thumbnailUrl}
                  alt={a.title}
                  className="h-40 w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
              </div>
            ) : null}
            {a.kind === "video" && (a.thumbnailUrl || a.coverUrl) ? (
              <MediaView
                kind="video"
                src={a.coverUrl}
                previewSrc={a.thumbnailUrl}
                alt={a.title}
                fit="contain"
                className="mb-3 h-40 w-full rounded-xl bg-black object-contain"
              />
            ) : null}
            {a.kind === "audio" && a.coverUrl ? (
              <div className="mb-3 grid h-32 place-items-center rounded-xl bg-[var(--ob-surface-2)] px-3">
                <audio src={a.coverUrl} aria-label={a.title} controls preload="none" className="w-full" />
              </div>
            ) : null}
            <div className="flex-1">
              <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 font-semibold text-[var(--ob-ink)] truncate" title={a.title}>{a.title}</h3>
                <span className="ob-chip shrink-0">
                  {a.kind === "text" ? t("common.text") : a.kind === "image" ? t("common.image") : a.kind === "video" ? t("common.video") : t("common.audio")}
                </span>
              </div>
              {a.source ? <p className="mt-0.5 truncate text-xs text-[var(--ob-muted)]">{a.source}</p> : null}
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--ob-muted)]">
                {a.kind === "text" ? a.content : a.mimeType}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-[var(--ob-line)] pt-3 text-sm">
              <button
                type="button"
                className="ob-btn ob-btn-sm"
                disabled={insertingId === a.id}
                aria-busy={insertingId === a.id}
                onClick={() => {
                  const project = useBoardStore.getState().getActive();
                  if (!project) {
                    setError(t("assets.openCanvasFirst"));
                    return;
                  }
                  setInsertingId(a.id);
                  void insertAsset(a.id, {
                    x: 80 + Math.random() * 120,
                    y: 80 + Math.random() * 120,
                  }).catch((cause) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }).finally(() => setInsertingId(null));
                }}
              >
                <Plus size={13} aria-hidden />
                {insertingId === a.id ? t("assets.inserting") : t("assets.insertCanvas")}
              </button>
              {a.kind === "text" ? (
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  onClick={() => void writeTextWithFallback(a.content ?? "").catch(() => undefined)}
                >
                  <Copy size={13} aria-hidden />
                  {t("common.copy")}
                </button>
              ) : null}
              {a.kind !== "text" && a.storageKey ? (
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  onClick={() =>
                    void downloadStorageKey(
                      a.storageKey!,
                      filenameForMimeType(a.title || a.id, a.mimeType, a.kind === "image" ? "png" : a.kind === "video" ? "mp4" : "mp3"),
                    )
                  }
                >
                  <Download size={13} aria-hidden />
                  {t("common.download")}
                </button>
              ) : null}
              <button
                type="button"
                className="ob-btn ob-btn-sm"
                onClick={() => {
                  setCreating(false);
                  setEditing(a);
                }}
              >
                <Edit3 size={13} aria-hidden />
                {t("common.edit")}
              </button>
              <button
                type="button"
                className="ob-btn ob-btn-danger ob-btn-sm ml-auto"
                aria-label={t("common.delete")}
                onClick={() => setPendingDelete(a)}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          </article>
        ))}
      </div>

      {!filtered.length ? (
        <div className="ob-empty mt-8">
          <span className="ob-empty-icon" aria-hidden>
            <FolderHeart size={20} />
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

      {pendingDelete ? (
        <ConfirmDialog
          title={t("assets.confirmDelete", { title: pendingDelete.title })}
          confirmLabel={t("common.delete")}
          tone="danger"
          busy={deletingId !== null}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void executeDelete(pendingDelete)}
        />
      ) : null}
    </div>
  );
}
