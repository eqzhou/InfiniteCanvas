import { useEffect, useState } from "react";
import { BookMarked, Check, Plus, RefreshCw, Rss, SlidersHorizontal, Tags, Trash2, X } from "lucide-react";
import {
  bulkDeleteAdminPrompts,
  createAdminPrompt,
  createAdminPromptCategory,
  createAdminPromptSource,
  deleteAdminPromptCategory,
  deleteAdminPromptSource,
  getAdminPromptCatalog,
  runDueAdminPromptSources,
  syncAdminPromptSource,
  syncAllAdminPromptSources,
  updateAdminPromptSource,
  updateAdminPromptCategory,
  updateAdminPrompt,
  type AdminPromptCatalog,
  type AdminPromptCategory,
  type AdminPromptSource,
  type AdminPromptSyncRun,
} from "@/services/admin";
import { COMMUNITY_PROMPT_SOURCE_PRESETS } from "@/services/prompt-source-presets";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyState, Notice, SectionHeader } from "./AdminSection";
import { useI18n } from "@/i18n/I18nProvider";

const EMPTY: AdminPromptCatalog = { version: 1, revision: 0, categories: [], prompts: [], sources: [], syncRuns: [] };

/** Sentinel for "no category", which is otherwise indistinguishable from "any". */
export const UNCATEGORIZED_FILTER = "__none__";

/** Server clamps the same bounds; mirrored here so the stepper cannot offer an invalid value. */
const INTERVAL_MIN_MINUTES = 5;
const INTERVAL_MAX_MINUTES = 10080;
const DEFAULT_INTERVAL_MINUTES = 30;
const RUN_HISTORY_LIMIT = 8;

export function normalizePromptSourceInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, Math.round(value)));
}

type AdminPromptFilter = { query: string; categoryId: string; tag: string };

type FilterablePrompt = {
  id: string;
  title: string;
  body: string;
  categoryId?: string;
  tags: string[];
};

type PromptSourceDraft = {
  id: string;
  name: string;
  url: string;
  format: "json" | "markdown";
};

type Perform = (action: () => Promise<unknown>) => Promise<void>;

/**
 * Narrows the catalog for the admin list. Filtering stays client-side because
 * the catalog is already fetched whole for editing; each criterion is
 * independent and an empty value means "any".
 */
export function filterAdminPrompts<T extends FilterablePrompt>(
  prompts: readonly T[],
  filter: AdminPromptFilter,
): T[] {
  const query = filter.query.trim().toLowerCase();
  const tag = filter.tag.trim().toLowerCase();
  return prompts.filter((item) => {
    if (filter.categoryId === UNCATEGORIZED_FILTER) {
      if (item.categoryId) return false;
    } else if (filter.categoryId && item.categoryId !== filter.categoryId) {
      return false;
    }
    if (tag && !item.tags.some((value) => value.toLowerCase() === tag)) return false;
    if (!query) return true;
    return item.title.toLowerCase().includes(query) ||
      item.body.toLowerCase().includes(query) ||
      item.tags.some((value) => value.toLowerCase().includes(query));
  });
}

/**
 * Keeps only the selected ids the admin can currently see. Bulk delete submits
 * the whole selection, so a prompt hidden by the active filter would otherwise
 * be deleted without ever being shown. The input array is returned unchanged
 * when nothing is hidden, so the caller's state update stays a no-op.
 */
export function retainVisibleSelection(
  selected: readonly string[],
  visible: readonly { id: string }[],
): string[] {
  if (!selected.length) return selected as string[];
  const visibleIds = new Set(visible.map((item) => item.id));
  const retained = selected.filter((id) => visibleIds.has(id));
  return retained.length === selected.length ? (selected as string[]) : retained;
}

export function AdminPromptCatalogPanel() {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState(EMPTY);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setCatalog(await getAdminPromptCatalog());
      setError("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const perform: Perform = async (action) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ob-admin-stack" aria-busy={loading || busy}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {loading ? <Notice tone="info">{t("admin.prompts.loading")}</Notice> : null}
      <CategoriesSection categories={catalog.categories} perform={perform} />
      <PromptsSection catalog={catalog} perform={perform} />
      <SourcesSection catalog={catalog} perform={perform} />
    </div>
  );
}

function CategoriesSection({ categories, perform }: { categories: readonly AdminPromptCategory[]; perform: Perform }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ id: "", name: "", order: 0 });
  const [editing, setEditing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdminPromptCategory | null>(null);

  const reset = () => { setDraft({ id: "", name: "", order: 0 }); setEditing(false); };
  const submit = () => void perform(async () => {
    await (editing ? updateAdminPromptCategory(draft) : createAdminPromptCategory(draft));
    reset();
  });

  return (
    <section className="ob-admin-section">
      <SectionHeader
        icon={<Tags size={16} />}
        title={t("admin.prompts.categories")}
        desc={t("admin.prompts.categoriesHint")}
        actions={<span className="ob-micro-label">{t("admin.prompts.categoryCount", { count: categories.length })}</span>}
      />

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.categoryId")}</span>
          <input
            className="ob-field w-full"
            value={draft.id}
            disabled={editing}
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.categoryName")}</span>
          <input
            className="ob-field w-full"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.categoryOrder")}</span>
          <input
            className="ob-field w-full"
            type="number"
            value={draft.order}
            onChange={(event) => setDraft({ ...draft, order: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="ob-record-actions">
        {editing ? (
          <button className="ob-btn" type="button" onClick={reset}>{t("admin.prompts.cancelEdit")}</button>
        ) : null}
        <span className="ob-record-actions-end" />
        <button className="ob-btn ob-btn-primary" type="button" disabled={!draft.id.trim() || !draft.name.trim()} onClick={submit}>
          {editing ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
          {editing ? t("admin.prompts.saveCategory") : t("admin.prompts.newCategory")}
        </button>
      </div>

      <div className="mt-3">
        {categories.length ? (
          <ul className="flex flex-wrap gap-2 p-0" role="list">
            {categories.map((item) => (
              <li key={item.id} className="ob-chip gap-1.5 py-1 pr-1 pl-2.5 text-[0.72rem] text-[var(--ob-ink)]">
                <span className="font-medium">{item.name}</span>
                <span className="text-[0.62rem] text-[var(--ob-muted)]">{item.order}</span>
                <button
                  className="ob-icon-btn ob-icon-btn-sm"
                  type="button"
                  aria-label={`${t("admin.prompts.edit")} ${item.name}`}
                  onClick={() => { setDraft(item); setEditing(true); }}
                >
                  <SlidersHorizontal size={12} aria-hidden />
                </button>
                <button
                  className="ob-icon-btn ob-icon-btn-sm"
                  type="button"
                  aria-label={`${t("admin.prompts.deleteCategory")} ${item.name}`}
                  onClick={() => setPendingDelete(item)}
                >
                  <X size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Tags size={20} />} title={t("admin.prompts.emptyCategories")} />
        )}
      </div>

      {pendingDelete ? (
        <ConfirmDialog
          title={t("admin.prompts.deleteCategory")}
          message={t("admin.prompts.confirmDeleteCategory", { name: pendingDelete.name })}
          confirmLabel={t("common.delete")}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void perform(() => deleteAdminPromptCategory(target.id));
          }}
        />
      ) : null}
    </section>
  );
}

function PromptsSection({ catalog, perform }: { catalog: AdminPromptCatalog; perform: Perform }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ id: "", title: "", body: "", categoryId: "", tags: "" });
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState({ query: "", categoryId: "", tag: "" });
  const [confirmingBatch, setConfirmingBatch] = useState(false);

  const visiblePrompts = filterAdminPrompts(catalog.prompts, filter);
  const tags = [...new Set(catalog.prompts.flatMap((item) => item.tags))].sort();

  // Bulk delete submits the whole selection, so drop anything the active
  // filter (or a catalog reload) hides before the admin can act on it.
  useEffect(() => {
    setSelected((current) => retainVisibleSelection(current, visiblePrompts));
  }, [visiblePrompts]);

  const reset = () => { setDraft({ id: "", title: "", body: "", categoryId: "", tags: "" }); setEditing(false); };
  const submit = () => void perform(async () => {
    const input = { ...draft, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
    await (editing ? updateAdminPrompt(input) : createAdminPrompt(input));
    reset();
  });

  return (
    <section className="ob-admin-section">
      <SectionHeader
        icon={<BookMarked size={16} />}
        title={t("admin.prompts.entries")}
        desc={t("admin.prompts.entriesHint")}
        actions={
          <span className="ob-micro-label">
            {t("admin.prompts.summary", { total: catalog.prompts.length, visible: visiblePrompts.length })}
          </span>
        }
      />

      <div className="grid gap-2 md:grid-cols-2">
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.promptId")}</span>
          <input
            className="ob-field w-full"
            value={draft.id}
            disabled={editing}
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.title")}</span>
          <input
            className="ob-field w-full"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.category")}</span>
          <select
            className="ob-field w-full"
            value={draft.categoryId}
            onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
          >
            <option value="">{t("admin.prompts.uncategorized")}</option>
            {catalog.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.tags")}</span>
          <input
            className="ob-field w-full"
            value={draft.tags}
            onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
          />
        </label>
        <label className="block md:col-span-2">
          <span className="ob-micro-label mb-1">{t("admin.prompts.body")}</span>
          <textarea
            className="ob-field min-h-28 w-full"
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          />
        </label>
      </div>

      <div className="ob-record-actions">
        {editing ? (
          <button className="ob-btn" type="button" onClick={reset}>{t("admin.prompts.cancelEdit")}</button>
        ) : null}
        <span className="ob-record-actions-end" />
        <button className="ob-btn ob-btn-primary" type="button" disabled={!draft.id.trim() || !draft.title.trim()} onClick={submit}>
          {editing ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
          {editing ? t("admin.prompts.savePrompt") : t("admin.prompts.newPrompt")}
        </button>
      </div>

      <div className="mt-5">
        <span className="ob-micro-label mb-1.5">{t("admin.prompts.filters")}</span>
        <div className="grid gap-2 md:grid-cols-3">
          <input
            className="ob-field"
            aria-label={t("admin.prompts.search")}
            placeholder={t("admin.prompts.searchPlaceholder")}
            value={filter.query}
            onChange={(event) => setFilter({ ...filter, query: event.target.value })}
          />
          <select
            className="ob-field"
            aria-label={t("admin.prompts.categoryFilter")}
            value={filter.categoryId}
            onChange={(event) => setFilter({ ...filter, categoryId: event.target.value })}
          >
            <option value="">{t("admin.prompts.allCategories")}</option>
            <option value={UNCATEGORIZED_FILTER}>{t("admin.prompts.uncategorized")}</option>
            {catalog.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <select
            className="ob-field"
            aria-label={t("admin.prompts.tagFilter")}
            value={filter.tag}
            onChange={(event) => setFilter({ ...filter, tag: event.target.value })}
          >
            <option value="">{t("admin.prompts.allTags")}</option>
            {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {visiblePrompts.length ? visiblePrompts.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-2.5 rounded-[0.7rem] border border-[color-mix(in_srgb,var(--ob-line)_75%,transparent)] bg-[color-mix(in_srgb,var(--ob-panel)_88%,transparent)] p-2.5 transition-colors hover:border-[color-mix(in_srgb,var(--ob-accent)_38%,var(--ob-line))]"
          >
            <input
              className="mt-0.5"
              aria-label={t("admin.prompts.selectPrompt", { title: item.title })}
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={(event) => setSelected((current) => (
                event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)
              ))}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[0.85rem] font-semibold text-[var(--ob-ink)]">{item.title}</span>
                {item.sourceId ? (
                  <span className="ob-status-chip" data-tone="info">
                    <Rss size={10} aria-hidden />
                    {t("admin.prompts.fromSource")}
                  </span>
                ) : null}
                {item.tags.map((tag) => <span key={tag} className="ob-chip">{tag}</span>)}
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--ob-muted)]">{item.body}</p>
            </div>
            {!item.sourceId ? (
              <button
                className="ob-icon-btn"
                type="button"
                aria-label={`${t("admin.prompts.edit")} ${item.title}`}
                onClick={() => {
                  setDraft({
                    id: item.id, title: item.title, body: item.body,
                    categoryId: item.categoryId ?? "", tags: item.tags.join(", "),
                  });
                  setEditing(true);
                }}
              >
                <SlidersHorizontal size={14} aria-hidden />
              </button>
            ) : null}
          </div>
        )) : <EmptyState icon={<BookMarked size={20} />} title={t("admin.prompts.emptyPrompts")} />}
      </div>

      {selected.length ? (
        <div className="ob-record-actions">
          <span className="ob-micro-label">{t("admin.prompts.selectedCount", { count: selected.length })}</span>
          <span className="ob-record-actions-end" />
          <button className="ob-btn ob-btn-danger" type="button" onClick={() => setConfirmingBatch(true)}>
            <Trash2 size={14} aria-hidden />
            {t("admin.prompts.deleteBatch")}
          </button>
        </div>
      ) : null}

      {confirmingBatch ? (
        <ConfirmDialog
          title={t("admin.prompts.deleteBatchTitle")}
          message={t("admin.prompts.confirmDeleteBatch", { count: selected.length })}
          confirmLabel={t("common.delete")}
          onCancel={() => setConfirmingBatch(false)}
          onConfirm={() => {
            const ids = selected;
            setConfirmingBatch(false);
            void perform(async () => { await bulkDeleteAdminPrompts(ids); setSelected([]); });
          }}
        />
      ) : null}
    </section>
  );
}

function SourcesSection({ catalog, perform }: { catalog: AdminPromptCatalog; perform: Perform }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<PromptSourceDraft>({ id: "", name: "", url: "", format: "json" });

  const addDraft = () => void perform(async () => {
    await createAdminPromptSource({ ...draft, enabled: true, scheduleEnabled: false, intervalMinutes: 0 });
    setDraft({ id: "", name: "", url: "", format: "json" });
  });

  return (
    <section className="ob-admin-section">
      <SectionHeader
        icon={<Rss size={16} />}
        title={t("admin.prompts.sources")}
        desc={t("admin.prompts.sourcesHint")}
        actions={<span className="ob-micro-label">{t("admin.prompts.sourceCount", { count: catalog.sources.length })}</span>}
      />

      <div className="grid gap-2 md:grid-cols-4">
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.sourceId")}</span>
          <input className="ob-field w-full" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.sourceName")}</span>
          <input className="ob-field w-full" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">URL</span>
          <input
            className="ob-field w-full"
            placeholder={t("admin.prompts.sourceUrl")}
            value={draft.url}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.format")}</span>
          <select
            className="ob-field w-full"
            value={draft.format}
            onChange={(event) => setDraft({ ...draft, format: event.target.value === "markdown" ? "markdown" : "json" })}
          >
            <option value="json">JSON</option>
            <option value="markdown">{t("admin.prompts.markdown")}</option>
          </select>
        </label>
      </div>

      <div className="ob-record-actions">
        <button className="ob-btn" type="button" onClick={() => void perform(syncAllAdminPromptSources)}>
          <RefreshCw size={14} aria-hidden />
          {t("admin.prompts.syncAll")}
        </button>
        <button className="ob-btn" type="button" onClick={() => void perform(runDueAdminPromptSources)}>
          {t("admin.prompts.runDue")}
        </button>
        <span className="ob-record-actions-end" />
        <button
          className="ob-btn ob-btn-primary"
          type="button"
          disabled={!draft.id.trim() || !draft.url.trim()}
          onClick={addDraft}
        >
          <Plus size={14} aria-hidden />
          {t("admin.prompts.addSource")}
        </button>
      </div>

      <div className="mt-4">
        <span className="ob-micro-label mb-1.5">{t("admin.prompts.builtin")}</span>
        <div className="flex flex-wrap gap-1.5">
          {COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="ob-btn"
              type="button"
              title={preset.description}
              disabled={catalog.sources.some((item) => item.id === preset.id || item.url === preset.source.url)}
              onClick={() => void perform(() => createAdminPromptSource({
                id: preset.id, name: preset.name, url: preset.source.url,
                format: preset.source.format === "markdown" ? "markdown" : "json",
                enabled: true, scheduleEnabled: false, intervalMinutes: 0,
              }))}
            >
              <Plus size={13} aria-hidden />
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {catalog.sources.length
          ? catalog.sources.map((item) => <PromptSourceRow key={item.id} source={item} perform={perform} />)
          : <EmptyState icon={<Rss size={20} />} title={t("admin.prompts.emptySources")} />}
      </div>

      <div className="mt-4">
        <span className="ob-micro-label mb-1.5">{t("admin.prompts.lastRun")}</span>
        {catalog.syncRuns.length ? (
          <ul className="space-y-1 p-0" role="list">
            {catalog.syncRuns.slice(-RUN_HISTORY_LIMIT).reverse().map((run) => (
              <SyncRunRow key={run.id} run={run} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--ob-muted)]">{t("admin.prompts.none")}</p>
        )}
      </div>
    </section>
  );
}

/**
 * One run of the sync history. The raw `syncRunSummary()` string is kept as the
 * accessible label so screen readers still get the whole line, while sighted
 * users read the status as a tonal chip instead of a `·`-joined string.
 */
function SyncRunRow({ run }: { run: AdminPromptSyncRun }) {
  const tone = run.status === "succeeded" ? "success" : run.status === "failed" ? "danger" : "info";
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--ob-canvas)_60%,transparent)] px-2 py-1.5 text-xs"
      aria-label={syncRunSummary(run)}
    >
      <span className="ob-status-dot" data-status={run.status} aria-hidden />
      <span className="font-medium text-[var(--ob-ink)]">{run.sourceId}</span>
      <span className="ob-status-chip" data-tone={tone}>{run.status}</span>
      <span className="text-[var(--ob-muted)]">{run.itemCount}</span>
      {run.error ? <span className="min-w-0 flex-1 truncate text-[var(--ob-danger)]">{run.error}</span> : null}
    </li>
  );
}

function PromptSourceRow({ source, perform }: { source: AdminPromptSource; perform: Perform }) {
  const { locale, t } = useI18n();
  const [interval, setIntervalValue] = useState(
    normalizePromptSourceInterval(source.intervalMinutes || DEFAULT_INTERVAL_MINUTES),
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const scheduled = Boolean(source.scheduleEnabled);

  useEffect(() => {
    setIntervalValue(normalizePromptSourceInterval(source.intervalMinutes || DEFAULT_INTERVAL_MINUTES));
  }, [source.id, source.intervalMinutes]);

  return (
    <div className="ob-record">
      <div className="ob-record-header">
        <span className="ob-record-title">{source.name}</span>
        <span className="ob-chip">{source.format.toUpperCase()}</span>
        <span className="ob-status-chip" data-tone={scheduled ? "success" : "info"}>
          <span className="ob-status-dot" data-status={scheduled ? "succeeded" : "pending"} aria-hidden />
          {source.scheduleStatus || t("admin.prompts.none")}
        </span>
        {source.lastError ? (
          <span className="ob-status-chip" data-tone="danger">{source.lastError}</span>
        ) : null}
      </div>

      <p className="truncate text-xs text-[var(--ob-muted)]">{source.url}</p>
      {source.nextRunAt ? (
        <p className="mt-1 text-xs text-[var(--ob-muted)]">
          {t("admin.prompts.nextRun")} · {new Date(source.nextRunAt).toLocaleString(locale)}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-1.5 text-sm text-[var(--ob-ink)]">
          <input
            type="checkbox"
            checked={scheduled}
            onChange={(event) => void perform(() => updateAdminPromptSource({
              ...source,
              scheduleEnabled: event.target.checked,
              intervalMinutes: event.target.checked ? normalizePromptSourceInterval(interval) : 0,
            }))}
          />
          {t("admin.prompts.schedule")}
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.prompts.interval")}</span>
          <input
            className="ob-field w-24"
            aria-label={`${source.name} ${t("admin.prompts.interval")}`}
            type="number"
            min={INTERVAL_MIN_MINUTES}
            max={INTERVAL_MAX_MINUTES}
            value={interval}
            onChange={(event) => {
              const next = Number(event.target.value);
              setIntervalValue(Number.isFinite(next) ? next : DEFAULT_INTERVAL_MINUTES);
            }}
            onBlur={() => {
              const next = normalizePromptSourceInterval(interval);
              setIntervalValue(next);
              if (!source.scheduleEnabled) return;
              void perform(() => updateAdminPromptSource({ ...source, scheduleEnabled: true, intervalMinutes: next }));
            }}
          />
        </label>
      </div>

      <div className="ob-record-actions">
        <button className="ob-btn" type="button" onClick={() => void perform(() => syncAdminPromptSource(source.id))}>
          <RefreshCw size={14} aria-hidden />
          {t("admin.prompts.sync")}
        </button>
        <span className="ob-record-actions-end" />
        <button className="ob-btn ob-btn-danger" type="button" onClick={() => setConfirmingDelete(true)}>
          <Trash2 size={14} aria-hidden />
          {t("admin.prompts.delete")}
        </button>
      </div>

      {confirmingDelete ? (
        <ConfirmDialog
          title={t("admin.prompts.deleteSourceTitle")}
          message={t("admin.prompts.confirmDeleteSource", { name: source.name })}
          confirmLabel={t("common.delete")}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void perform(() => deleteAdminPromptSource(source.id));
          }}
        />
      ) : null}
    </div>
  );
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

export function syncRunSummary(run: { sourceId: string; status: string; itemCount: number; error?: string }): string {
  return `${run.sourceId} · ${run.status} · ${run.itemCount}${run.error ? ` · ${run.error}` : ""}`;
}
