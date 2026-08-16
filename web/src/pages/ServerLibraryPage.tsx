import { useCallback, useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { hasTenantOwnerCapability } from "@/services/admin";
import {
  createLibraryAsset,
  deleteLibraryAsset,
  listLibraryAssets,
  updateLibraryAsset,
  type LibraryAsset,
  type LibraryAssetInput,
  type LibraryAssetKind,
} from "@/services/library-assets";
import { findOpenNodePosition } from "@/lib/node-placement";
import { LibraryAssetDetailDialog } from "@/components/library/LibraryAssetDetailDialog";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DEFAULT_NODE_SIZE } from "@/lib/defaults";
import { nowIso, uid } from "@/lib/id";
import { writeTextWithFallback } from "@/lib/clipboard";
import type { AssetItem } from "@/types/board";
import { useI18n } from "@/i18n/I18nProvider";
import {
  Copy,
  Edit3,
  Eye,
  FolderPlus,
  Library,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";

function emptyDraft(kind: LibraryAssetKind = "image"): LibraryAssetInput {
  return {
    kind,
    title: "",
    tags: [],
    content: "",
    coverUrl: "",
    source: "",
    notes: "",
  };
}

export function ServerLibraryPage() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const addNode = useBoardStore((s) => s.addNode);
  const getActive = useBoardStore((s) => s.getActive);
  const setAssets = useBoardStore((s) => s.setAssets);
  const flushAssets = useBoardStore((s) => s.flushAssets);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | LibraryAssetKind>("all");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LibraryAsset | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<LibraryAssetInput>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LibraryAsset | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryAsset | null>(null);
  const pageSize = 12;
  const canManage = hasTenantOwnerCapability(auth);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listLibraryAssets({ q, kind, tag, page, pageSize });
      setItems(result.items);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [q, kind, tag, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [q, kind]);

  const kindLabel = useMemo(
    () =>
      ({
        text: t("common.text"),
        image: t("common.image"),
        video: t("common.video"),
        audio: t("common.audio"),
      }) as Record<LibraryAssetKind, string>,
    [t],
  );

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft(kind === "all" ? "image" : kind));
    setCreating(true);
  };

  const openEdit = (asset: LibraryAsset) => {
    setCreating(false);
    setEditing(asset);
    setDraft({
      kind: asset.kind,
      title: asset.title,
      tags: asset.tags,
      content: asset.content ?? "",
      coverUrl: asset.coverUrl ?? "",
      source: asset.source ?? "",
      notes: asset.notes ?? "",
    });
  };

  const closeEditor = () => {
    if (busy) return;
    setCreating(false);
    setEditing(null);
  };

  const saveDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: LibraryAssetInput = {
        ...draft,
        title: draft.title.trim(),
        tags: (draft.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
        content: draft.content?.trim() || undefined,
        coverUrl: draft.coverUrl?.trim() || undefined,
        source: draft.source?.trim() || undefined,
        notes: draft.notes?.trim() || undefined,
      };
      if (editing) await updateLibraryAsset(editing.id, payload);
      else await createLibraryAsset(payload);
      setCreating(false);
      setEditing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const executeDelete = async (asset: LibraryAsset) => {
    setBusy(true);
    setError(null);
    try {
      await deleteLibraryAsset(asset.id);
      setPendingDelete(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyAssetValue = async (asset: LibraryAsset) => {
    const value = asset.kind === "text"
      ? (asset.content ?? "")
      : (asset.coverUrl || asset.content || "");
    if (!value) {
      setError(asset.kind === "text" ? t("serverLibrary.noText") : t("serverLibrary.noLink"));
      return;
    }
    try {
      await writeTextWithFallback(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("serverLibrary.copyFailed"));
    }
  };

  const addToMyAssets = async (asset: LibraryAsset) => {
    setSavingId(asset.id);
    setError(null);
    try {
      const timestamp = nowIso();
      const item: AssetItem = {
        id: uid("asset"),
        kind: asset.kind,
        title: asset.title,
        tags: [...asset.tags],
        notes: asset.notes || undefined,
        source: asset.source || t("serverLibrary.title"),
        content: asset.kind === "text" ? (asset.content ?? "") : undefined,
        coverUrl: asset.kind === "text" ? undefined : (asset.coverUrl || asset.content || undefined),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      setAssets([item, ...useBoardStore.getState().assets]);
      await flushAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingId(null);
    }
  };

  const insertToCanvas = async (asset: LibraryAsset) => {
    const project = getActive();
    if (!project) {
      setError(t("assets.openCanvasFirst"));
      return;
    }
    setInsertingId(asset.id);
    try {
      const size =
        asset.kind === "video"
          ? DEFAULT_NODE_SIZE.video
          : asset.kind === "audio"
            ? DEFAULT_NODE_SIZE.audio
            : asset.kind === "text"
              ? DEFAULT_NODE_SIZE.text
              : DEFAULT_NODE_SIZE.image;
      const position = findOpenNodePosition(project.nodes, { x: 120, y: 120 }, size);
      if (asset.kind === "text") {
        addNode("text", position, {
          title: asset.title,
          metadata: { content: asset.content ?? "", status: "success" },
        });
      } else {
        addNode(asset.kind, position, {
          title: asset.title,
          metadata: {
            content: asset.coverUrl || asset.content,
            status: "success",
          },
        });
      }
      await useBoardStore.getState().persistNow();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInsertingId(null);
    }
  };

  const editorOpen = creating || Boolean(editing);

  return (
    <div className="ob-page ob-view-fade-in pb-12">
      <header className="ob-page-header">
        <div className="min-w-0">
          <span className="ob-page-kicker"><Library size={13} aria-hidden />{t("nav.serverLibrary")}</span>
          <h1 className="ob-page-title">{t("serverLibrary.title")}</h1>
          <p className="ob-page-desc">{t("serverLibrary.description")}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {canManage ? (
            <button type="button" className="ob-btn-primary" onClick={openCreate}>
              <Plus size={14} aria-hidden />
              {t("serverLibrary.new")}
            </button>
          ) : null}
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
            placeholder={t("serverLibrary.search")}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        <select
          className="ob-field w-auto cursor-pointer"
          value={kind}
          onChange={(event) => setKind(event.target.value as "all" | LibraryAssetKind)}
        >
          <option value="all">{t("common.allTypes")}</option>
          <option value="image">{t("common.image")}</option>
          <option value="video">{t("common.video")}</option>
          <option value="audio">{t("common.audio")}</option>
          <option value="text">{t("common.text")}</option>
        </select>
        <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
          <Tag size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ob-muted)]" aria-hidden />
          <input
            className="ob-field pl-8"
            aria-label={t("serverLibrary.tagFilter")}
            placeholder={t("serverLibrary.tagPlaceholder")}
            value={tag}
            onChange={(event) => { setTag(event.target.value); setPage(1); }}
          />
        </div>
        <button type="button" className="ob-btn ml-auto" onClick={() => void load()}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden />
          {t("common.refresh")}
        </button>
      </div>

      {loading ? (
        <div className="ob-card p-12 text-center text-sm text-[var(--ob-muted)]">
          <RefreshCw size={18} className="mx-auto mb-2 animate-spin text-[var(--ob-accent)]" />
          {t("serverLibrary.loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="ob-empty mt-8">
          <span className="ob-empty-icon" aria-hidden><Library size={20} /></span>
          <p className="ob-empty-title">{t("serverLibrary.empty")}</p>
          <p className="ob-empty-desc">{canManage ? t("serverLibrary.emptyAdmin") : t("serverLibrary.emptyMember")}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((asset) => (
            <article
              key={asset.id}
              className="ob-card group flex flex-col overflow-hidden p-4 transition-all hover:shadow-[var(--ob-elev-2)]"
            >
              {asset.kind !== "text" && (asset.coverUrl || asset.content) ? (
                <div className="mb-3 overflow-hidden rounded-xl bg-[var(--ob-surface-2)]">
                  {asset.kind === "image" ? (
                    <img
                      src={asset.coverUrl || asset.content}
                      alt={asset.title}
                      className="h-36 w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : asset.kind === "video" ? (
                    <video
                      src={asset.coverUrl || asset.content}
                      className="h-36 w-full object-cover bg-black"
                      controls
                      preload="metadata"
                    />
                  ) : (
                    <div className="grid h-28 place-items-center px-3">
                      <audio src={asset.coverUrl || asset.content} controls preload="none" className="w-full" />
                    </div>
                  )}
                </div>
              ) : null}
              <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 font-semibold text-[var(--ob-ink)] truncate" title={asset.title}>{asset.title}</h2>
                <span className="ob-chip shrink-0">{kindLabel[asset.kind]}</span>
              </div>
              {asset.source ? <p className="mt-1 truncate text-xs text-[var(--ob-muted)]">{asset.source}</p> : null}
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--ob-muted)]">
                {asset.kind === "text" ? asset.content : asset.notes || asset.coverUrl || asset.content}
              </p>
              {asset.tags.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {asset.tags.map((t) => (
                    <span key={t} className="ob-chip text-[0.7rem]">
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-[var(--ob-line)] pt-3 text-sm">
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  disabled={insertingId === asset.id}
                  onClick={() => void insertToCanvas(asset)}
                >
                  <Plus size={13} aria-hidden />
                  {insertingId === asset.id ? t("assets.inserting") : t("assets.insertCanvas")}
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  onClick={() => void copyAssetValue(asset)}
                >
                  <Copy size={13} aria-hidden />
                  {asset.kind === "text" ? t("serverLibrary.copyText") : t("serverLibrary.copyLink")}
                </button>
                <button type="button" className="ob-btn ob-btn-sm" onClick={() => setDetail(asset)}>
                  <Eye size={13} aria-hidden />
                  {t("serverLibrary.viewDetails")}
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  disabled={savingId === asset.id}
                  onClick={() => void addToMyAssets(asset)}
                >
                  <FolderPlus size={13} aria-hidden />
                  {savingId === asset.id ? t("serverLibrary.adding") : t("serverLibrary.addMine")}
                </button>
                {canManage ? (
                  <>
                    <button type="button" className="ob-btn ob-btn-sm ml-auto" onClick={() => openEdit(asset)}>
                      <Edit3 size={13} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="ob-btn ob-btn-danger ob-btn-sm"
                      aria-label={t("common.delete")}
                      onClick={() => setPendingDelete(asset)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="mt-8 flex items-center justify-center gap-4 text-sm">
          <button type="button" className="ob-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t("common.previousPage")}
          </button>
          <span className="ob-chip px-4 py-1.5 text-xs text-[var(--ob-muted)]">
            {t("common.pageTotal", { page, pages: totalPages, total })}
          </span>
          <button
            type="button"
            className="ob-btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("common.nextPage")}
          </button>
        </div>
      ) : null}

      {editorOpen ? (
        <div className="ob-overlay z-[120] p-4" onClick={closeEditor}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editing ? t("serverLibrary.edit") : t("serverLibrary.new")}
            className="ob-surface ob-view-fade-in mx-auto mt-[8vh] max-w-lg p-5 shadow-[var(--ob-elev-2)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ob-admin-section-header !mb-3">
              <span className="ob-admin-section-icon" aria-hidden><Library size={16} /></span>
              <div className="ob-admin-section-heading">
                <h2 className="ob-admin-section-title">
                  {editing ? t("serverLibrary.edit") : t("serverLibrary.new")}
                </h2>
                <p className="ob-admin-section-desc">{t("serverLibrary.description")}</p>
              </div>
              <button
                type="button"
                className="ob-icon-btn ob-icon-btn-sm ml-auto"
                aria-label={t("common.close")}
                onClick={closeEditor}
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <div className="mt-3 grid gap-3">
              <label className="block">
                <span className="ob-micro-label mb-1">{t("serverLibrary.kind")}</span>
                <select
                  className="ob-field"
                  value={draft.kind}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, kind: event.target.value as LibraryAssetKind }))
                  }
                >
                  <option value="image">{t("common.image")}</option>
                  <option value="video">{t("common.video")}</option>
                  <option value="audio">{t("common.audio")}</option>
                  <option value="text">{t("common.text")}</option>
                </select>
              </label>
              <label className="block">
                <span className="ob-micro-label mb-1">{t("serverLibrary.assetTitle")}</span>
                <input
                  className="ob-field"
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                />
              </label>
              <label className="block">
                <span className="ob-micro-label mb-1">{t("serverLibrary.tags")}</span>
                <input
                  className="ob-field"
                  value={(draft.tags ?? []).join(", ")}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      tags: event.target.value.split(",").map((s) => s.trim()),
                    }))
                  }
                  placeholder={t("serverLibrary.tagPlaceholder")}
                />
              </label>
              {draft.kind === "text" ? (
                <label className="block">
                  <span className="ob-micro-label mb-1">{t("serverLibrary.textContent")}</span>
                  <textarea
                    rows={4}
                    className="ob-field font-mono text-xs"
                    value={draft.content ?? ""}
                    onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="ob-micro-label mb-1">{t("serverLibrary.cover")}</span>
                  <input
                    className="ob-field"
                    value={draft.coverUrl ?? ""}
                    onChange={(event) => setDraft((current) => ({ ...current, coverUrl: event.target.value }))}
                  />
                </label>
              )}
              <label className="block">
                <span className="ob-micro-label mb-1">{t("serverLibrary.source")}</span>
                <input
                  className="ob-field"
                  value={draft.source ?? ""}
                  onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))}
                />
              </label>
              <label className="block">
                <span className="ob-micro-label mb-1">{t("serverLibrary.notes")}</span>
                <textarea
                  rows={2}
                  className="ob-field text-xs"
                  value={draft.notes ?? ""}
                  onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>
            </div>
            <div className="ob-record-actions mt-5 justify-end">
              <button type="button" className="ob-btn" disabled={busy} onClick={closeEditor}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="ob-btn ob-btn-primary"
                disabled={busy || !draft.title.trim()}
                onClick={() => void saveDraft()}
              >
                {busy ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detail ? (
        <LibraryAssetDetailDialog asset={detail} onClose={() => setDetail(null)} />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={t("serverLibrary.confirmDelete", { title: pendingDelete.title })}
          confirmLabel={t("common.delete")}
          tone="danger"
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void executeDelete(pendingDelete)}
        />
      ) : null}
    </div>
  );
}
