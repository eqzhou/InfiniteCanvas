import { useCallback, useEffect, useRef, useState } from "react";
import { FilePlus2, Library, Pencil, Trash2 } from "lucide-react";
import { EmptyState, Notice, SectionHeader } from "@/components/admin/AdminSection";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import {
  createLibraryAsset,
  deleteLibraryAsset,
  listLibraryAssets,
  updateLibraryAsset,
  type LibraryAsset,
  type LibraryAssetKind,
} from "@/services/library-assets";
import { useI18n } from "@/i18n/I18nProvider";

const EMPTY_DRAFT = { id: "", kind: "text" as LibraryAssetKind, title: "", tags: "", content: "", source: "", notes: "" };

const kindTone: Record<LibraryAssetKind, "info" | "success" | "warning" | "danger"> = {
  text: "info", image: "success", video: "warning", audio: "danger",
};

/**
 * Server material library management inside the admin console. The same CRUD
 * API also powers the reader-facing page; authorization stays server-side, so
 * this panel only decides what to show.
 */
export function AdminLibraryPanel() {
  const { locale, t } = useI18n();
  const kindLabels: Record<LibraryAssetKind, string> = {
    text: t("common.text"), image: t("common.image"), video: t("common.video"), audio: t("common.audio"),
  };
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | LibraryAssetKind>("all");
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LibraryAsset | null>(null);
  // Monotonic request id: a slow earlier response must never overwrite the
  // result of a newer filter.
  const requestIdRef = useRef(0);
  const mutationBusyRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      setError("");
      const page = await listLibraryAssets({ q, kind, tag, pageSize: 100 });
      if (requestId !== requestIdRef.current) return;
      setItems(page.items);
      setTotal(page.total);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setItems([]);
      setTotal(0);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [q, kind, tag]);

  useEffect(() => { void load(); }, [load]);

  // A filter change invalidates whatever is still in flight.
  useEffect(() => () => { requestIdRef.current += 1; }, []);

  const perform = async (action: () => Promise<unknown>) => {
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setSaving(true);
    try {
      setError("");
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutationBusyRef.current = false;
      setSaving(false);
    }
  };

  const save = () => void perform(async () => {
    const input = {
      kind: draft.kind,
      title: draft.title.trim(),
      tags: draft.tags.split(",").map((value) => value.trim()).filter(Boolean),
      content: draft.content.trim() || undefined,
      source: draft.source.trim() || undefined,
      notes: draft.notes.trim() || undefined,
    };
    if (editing && draft.id) await updateLibraryAsset(draft.id, input);
    else await createLibraryAsset(input);
    setDraft(EMPTY_DRAFT);
    setEditing(false);
  });

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    void perform(() => deleteLibraryAsset(target.id));
  };

  return (
    <div className="ob-admin-stack" aria-busy={loading || saving}>
      <section className="ob-admin-section">
        <SectionHeader
          icon={<FilePlus2 size={16} />}
          title={editing ? t("admin.library.edit") : t("admin.library.new")}
          desc={t("admin.library.hint")}
        />
        <fieldset className="contents" disabled={saving}>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="ob-micro-label mb-1">{t("admin.library.kind")}</span>
              <select className="ob-field" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as LibraryAssetKind })}>
                {(Object.keys(kindLabels) as LibraryAssetKind[]).map((value) => (
                  <option key={value} value={value}>{kindLabels[value]}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="ob-micro-label mb-1">{t("admin.library.title")}</span>
              <input className="ob-field" placeholder={t("admin.library.titlePlaceholder")} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label className="block">
              <span className="ob-micro-label mb-1">{t("admin.library.tags")}</span>
              <input className="ob-field" placeholder={t("admin.library.tagsPlaceholder")} value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
            </label>
            <label className="block">
              <span className="ob-micro-label mb-1">{t("admin.library.source")}</span>
              <input className="ob-field" placeholder={t("admin.library.sourcePlaceholder")} value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} />
            </label>
            <label className="block md:col-span-2">
              <span className="ob-micro-label mb-1">{t("admin.library.content")}</span>
              <textarea className="ob-field min-h-20" placeholder={t("admin.library.contentPlaceholder")} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
            </label>
            <label className="block md:col-span-2">
              <span className="ob-micro-label mb-1">{t("admin.library.notes")}</span>
              <textarea className="ob-field min-h-16" placeholder={t("admin.library.notesPlaceholder")} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
            </label>
          </div>
          <div className="ob-record-actions">
            {editing ? (
              <button type="button" className="ob-btn" onClick={() => { setDraft(EMPTY_DRAFT); setEditing(false); }}>{t("admin.library.cancelEdit")}</button>
            ) : null}
            <span className="ob-record-actions-end" />
            <button type="button" className="ob-btn ob-btn-primary" disabled={saving || !draft.title.trim()} onClick={save}>
              {saving ? t("admin.library.saving") : editing ? t("admin.library.save") : t("admin.library.new")}
            </button>
          </div>
        </fieldset>
        {error ? <div className="mt-3"><Notice tone="danger">{error}</Notice></div> : null}
      </section>

      <section className="ob-admin-section">
        <SectionHeader
          icon={<Library size={16} />}
          title={t("admin.tab.library")}
          desc={t("admin.library.summary", { total, visible: items.length })}
          actions={loading ? null : <span className="ob-micro-label">{t("admin.library.count", { count: total.toLocaleString(locale) })}</span>}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="ob-micro-label mb-1">{t("admin.library.search")}</span>
            <input className="ob-field" placeholder={t("admin.library.searchPlaceholder")} value={q} disabled={saving} onChange={(event) => setQ(event.target.value)} />
          </label>
          <label className="block">
            <span className="ob-micro-label mb-1">{t("admin.library.kindFilter")}</span>
            <select className="ob-field" value={kind} disabled={saving} onChange={(event) => setKind(event.target.value as "all" | LibraryAssetKind)}>
              <option value="all">{t("common.allTypes")}</option>
              {(Object.keys(kindLabels) as LibraryAssetKind[]).map((value) => (
                <option key={value} value={value}>{kindLabels[value]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="ob-micro-label mb-1">{t("admin.library.tagFilter")}</span>
            <input className="ob-field" placeholder={t("admin.library.tagPlaceholder")} value={tag} disabled={saving} onChange={(event) => setTag(event.target.value)} />
          </label>
        </div>

        <div className="mt-4">
          {loading ? (
            <Notice tone="info">{t("admin.library.loading")}</Notice>
          ) : items.length === 0 ? (
            <EmptyState icon={<Library size={20} />} title={t("admin.library.empty")} />
          ) : (
            <div className="ob-table-shell max-h-[52vh] overflow-auto">
              <ul className="divide-y divide-[color-mix(in_srgb,var(--ob-line)_55%,transparent)]">
                {items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                    <span className="ob-status-chip" data-tone={kindTone[item.kind]}>{kindLabels[item.kind]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--ob-ink)]">{item.title || t("admin.unnamed")}</span>
                      {item.tags.length || item.source ? (
                        <span className="block truncate text-xs text-[var(--ob-muted)]">
                          {[item.tags.join(" · "), item.source].filter(Boolean).join(" — ")}
                        </span>
                      ) : null}
                    </span>
                    <button type="button" className="ob-btn" disabled={saving} onClick={() => {
                      setDraft({
                        id: item.id, kind: item.kind, title: item.title, tags: item.tags.join(", "),
                        content: item.content ?? "", source: item.source ?? "", notes: item.notes ?? "",
                      });
                      setEditing(true);
                    }}><Pencil size={13} aria-hidden />{t("common.edit")}</button>
                    <button type="button" className="ob-btn ob-btn-danger" disabled={saving} aria-label={t("admin.library.deleteLabel", { title: item.title })} onClick={() => setDeleteTarget(item)}>
                      <Trash2 size={13} aria-hidden />{t("common.delete")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {deleteTarget ? (
        <ConfirmDialog
          title={t("admin.library.deleteTitle")}
          message={t("admin.library.confirmDelete", { title: deleteTarget.title })}
          confirmLabel={t("common.delete")}
          busy={saving}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
    </div>
  );
}
