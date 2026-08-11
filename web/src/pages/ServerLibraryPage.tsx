import { useCallback, useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { canManageAdmin } from "@/services/admin";
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
import { DEFAULT_NODE_SIZE } from "@/lib/defaults";
import { nowIso, uid } from "@/lib/id";
import { writeTextWithFallback } from "@/lib/clipboard";
import type { AssetItem } from "@/types/board";
import { useI18n } from "@/i18n/I18nProvider";

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
  const pageSize = 12;
  const canManage = canManageAdmin(auth);
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

  const removeAsset = async (asset: LibraryAsset) => {
    if (!window.confirm(t("serverLibrary.confirmDelete", { title: asset.title }))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteLibraryAsset(asset.id);
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
      window.alert(asset.kind === "text" ? t("serverLibrary.noText") : t("serverLibrary.noLink"));
      return;
    }
    try {
      await writeTextWithFallback(value);
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : t("serverLibrary.copyFailed"));
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
      window.alert(t("assets.openCanvasFirst"));
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
      window.alert(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInsertingId(null);
    }
  };

  const editorOpen = creating || Boolean(editing);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ob-ink)]">{t("serverLibrary.title")}</h1>
          <p className="mt-1 text-sm text-[var(--ob-muted)]">
            {t("serverLibrary.description")}
          </p>
        </div>
        {canManage ? (
          <button type="button" className="ob-btn-primary" onClick={openCreate}>
            {t("serverLibrary.new")}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="ob-input min-w-[12rem] flex-1"
          placeholder={t("serverLibrary.search")}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <select
          className="ob-input w-auto"
          value={kind}
          onChange={(event) => setKind(event.target.value as "all" | LibraryAssetKind)}
        >
          <option value="all">{t("common.allTypes")}</option>
          <option value="image">{t("common.image")}</option>
          <option value="video">{t("common.video")}</option>
          <option value="audio">{t("common.audio")}</option>
          <option value="text">{t("common.text")}</option>
        </select>
        <input
          className="ob-input w-auto min-w-[8rem]"
          aria-label={t("serverLibrary.tagFilter")}
          placeholder={t("serverLibrary.tagPlaceholder")}
          value={tag}
          onChange={(event) => { setTag(event.target.value); setPage(1); }}
        />
        <button type="button" className="ob-btn" onClick={() => void load()}>
          {t("common.refresh")}
        </button>
      </div>

      {error ? (
        <div role="alert" className="ob-banner" data-tone="warning">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-xl border border-[var(--ob-line)] p-8 text-sm text-[var(--ob-muted)]">
          {t("serverLibrary.loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--ob-line)] p-8 text-sm text-[var(--ob-muted)]">
          {t("serverLibrary.empty")}{canManage ? t("serverLibrary.emptyAdmin") : t("serverLibrary.emptyMember")}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((asset) => (
            <article
              key={asset.id}
              className="flex flex-col rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 shadow-[var(--ob-elev-1)]"
            >
              {asset.kind !== "text" && (asset.coverUrl || asset.content) ? (
                <div className="mb-3 overflow-hidden rounded-lg bg-[var(--ob-canvas)]">
                  {asset.kind === "image" ? (
                    <img
                      src={asset.coverUrl || asset.content}
                      alt={asset.title}
                      className="h-32 w-full object-cover"
                    />
                  ) : asset.kind === "video" ? (
                    <video
                      src={asset.coverUrl || asset.content}
                      className="h-32 w-full object-cover"
                      controls
                      preload="metadata"
                    />
                  ) : (
                    <div className="grid h-24 place-items-center px-3">
                      <audio src={asset.coverUrl || asset.content} controls preload="none" className="w-full" />
                    </div>
                  )}
                </div>
              ) : null}
              <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 font-semibold text-[var(--ob-ink)]">{asset.title}</h2>
                <span className="ob-chip shrink-0">{kindLabel[asset.kind]}</span>
              </div>
              {asset.source ? <p className="mt-1 truncate text-xs text-[var(--ob-muted)]">{asset.source}</p> : null}
              <p className="mt-2 line-clamp-3 text-sm text-[var(--ob-muted)]">
                {asset.kind === "text" ? asset.content : asset.notes || asset.coverUrl || asset.content}
              </p>
              {asset.tags.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {asset.tags.map((tag) => (
                    <span key={tag} className="ob-chip">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--ob-line)] pt-3">
                <button
                  type="button"
                  className="ob-btn"
                  disabled={insertingId === asset.id}
                  onClick={() => void insertToCanvas(asset)}
                >
                  {insertingId === asset.id ? t("assets.inserting") : t("assets.insertCanvas")}
                </button>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => void copyAssetValue(asset)}
                >
                  {asset.kind === "text" ? t("serverLibrary.copyText") : t("serverLibrary.copyLink")}
                </button>
                <button type="button" className="ob-btn" onClick={() => setDetail(asset)}>
                  {t("serverLibrary.viewDetails")}
                </button>
                <button
                  type="button"
                  className="ob-btn"
                  disabled={savingId === asset.id}
                  onClick={() => void addToMyAssets(asset)}
                >
                  {savingId === asset.id ? t("serverLibrary.adding") : t("serverLibrary.addMine")}
                </button>
                {canManage ? (
                  <>
                    <button type="button" className="ob-btn" onClick={() => openEdit(asset)}>
                      {t("common.edit")}
                    </button>
                    <button type="button" className="ob-btn" onClick={() => void removeAsset(asset)}>
                      {t("common.delete")}
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-center gap-2">
          <button type="button" className="ob-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t("common.previousPage")}
          </button>
          <span className="text-sm text-[var(--ob-muted)]">
            {page} / {totalPages}
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
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={closeEditor}>
          <div
            role="dialog"
            aria-label={editing ? t("serverLibrary.edit") : t("serverLibrary.new")}
            className="w-full max-w-lg rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 shadow-[var(--ob-elev-2)]"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-[var(--ob-ink)]">
              {editing ? t("serverLibrary.edit") : t("serverLibrary.new")}
            </h2>
            <div className="mt-3 grid gap-2">
              <label className="text-sm text-[var(--ob-muted)]">
                {t("serverLibrary.kind")}
                <select
                  className="ob-input mt-1"
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
              <label className="text-sm text-[var(--ob-muted)]">
                {t("serverLibrary.assetTitle")}
                <input
                  className="ob-input mt-1"
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                />
              </label>
              <label className="text-sm text-[var(--ob-muted)]">
                {t("serverLibrary.tags")}
                <input
                  className="ob-input mt-1"
                  value={(draft.tags ?? []).join(", ")}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean),
                    }))
                  }
                />
              </label>
              {draft.kind === "text" ? (
                <label className="text-sm text-[var(--ob-muted)]">
                  {t("serverLibrary.textContent")}
                  <textarea
                    className="ob-input mt-1 min-h-28"
                    value={draft.content ?? ""}
                    onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  />
                </label>
              ) : (
                <label className="text-sm text-[var(--ob-muted)]">
                  {t("serverLibrary.mediaUrl")}
                  <input
                    className="ob-input mt-1"
                    value={draft.coverUrl || draft.content || ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        coverUrl: event.target.value,
                        content: event.target.value,
                      }))
                    }
                  />
                </label>
              )}
              <label className="text-sm text-[var(--ob-muted)]">
                {t("serverLibrary.source")}
                <input
                  className="ob-input mt-1"
                  value={draft.source ?? ""}
                  onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))}
                />
              </label>
              <label className="text-sm text-[var(--ob-muted)]">
                {t("serverLibrary.notes")}
                <textarea
                  className="ob-input mt-1 min-h-20"
                  value={draft.notes ?? ""}
                  onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="ob-btn" disabled={busy} onClick={closeEditor}>
                {t("common.cancel")}
              </button>
              <button type="button" className="ob-btn-primary" disabled={busy} onClick={() => void saveDraft()}>
                {busy ? t("serverLibrary.saving") : t("serverLibrary.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <LibraryAssetDetailDialog asset={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
