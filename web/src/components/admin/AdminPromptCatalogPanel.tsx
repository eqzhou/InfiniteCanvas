import { useEffect, useState } from "react";
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
  type AdminPromptSource,
} from "@/services/admin";
import { COMMUNITY_PROMPT_SOURCE_PRESETS } from "@/services/prompt-source-presets";
import { useI18n } from "@/i18n/I18nProvider";

const EMPTY: AdminPromptCatalog = { version: 1, revision: 0, categories: [], prompts: [], sources: [], syncRuns: [] };

/** Sentinel for "no category", which is otherwise indistinguishable from "any". */
export const UNCATEGORIZED_FILTER = "__none__";

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
  const [category, setCategory] = useState({ id: "", name: "", order: 0 });
  const [categoryEditing, setCategoryEditing] = useState(false);
  const [prompt, setPrompt] = useState({ id: "", title: "", body: "", categoryId: "", tags: "" });
  const [promptEditing, setPromptEditing] = useState(false);
  const [source, setSource] = useState<PromptSourceDraft>({ id: "", name: "", url: "", format: "json" });
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState({ query: "", categoryId: "", tag: "" });
  const load = async () => { try { setCatalog(await getAdminPromptCatalog()); setError(""); } catch (cause) { setError(message(cause)); } };
  useEffect(() => { void load(); }, []);
  const perform = async (action: () => Promise<unknown>) => { try { await action(); await load(); } catch (cause) { setError(message(cause)); } };
  const visiblePrompts = filterAdminPrompts(catalog.prompts, filter);

  // Bulk delete submits the whole selection, so drop anything the active
  // filter (or a catalog reload) hides before the admin can act on it.
  useEffect(() => {
    setSelected((current) => retainVisibleSelection(current, visiblePrompts));
  }, [visiblePrompts]);

  return <div className="space-y-5">
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    <section className="space-y-2">
      <h2 className="font-semibold">{t("admin.prompts.categories")}</h2>
      <div className="flex flex-wrap gap-2">
        <input className="ob-field max-w-48" placeholder={t("admin.prompts.categoryId")} value={category.id} onChange={(event) => setCategory({ ...category, id: event.target.value })} />
        <input className="ob-field max-w-48" placeholder={t("admin.prompts.categoryName")} value={category.name} onChange={(event) => setCategory({ ...category, name: event.target.value })} />
        <input className="ob-field w-24" aria-label={t("admin.prompts.categoryOrder")} type="number" value={category.order} onChange={(event) => setCategory({ ...category, order: Number(event.target.value) })} />
        <button className="ob-btn" type="button" onClick={() => void perform(async () => { await (categoryEditing ? updateAdminPromptCategory(category) : createAdminPromptCategory(category)); setCategory({ id: "", name: "", order: 0 }); setCategoryEditing(false); })}>{categoryEditing ? t("admin.prompts.saveCategory") : t("admin.prompts.newCategory")}</button>
      </div>
      <div className="flex flex-wrap gap-2">{catalog.categories.map((item) => <span className="ob-chip" key={item.id}>{item.name}<button className="ml-2" type="button" onClick={() => { setCategory(item); setCategoryEditing(true); }}>{t("admin.prompts.edit")}</button><button className="ml-2" type="button" aria-label={`${t("admin.prompts.deleteCategory")} ${item.name}`} onClick={() => void perform(() => deleteAdminPromptCategory(item.id))}>×</button></span>)}</div>
      <div className="grid gap-2 md:grid-cols-2">
        <input className="ob-field" placeholder={t("admin.prompts.promptId")} value={prompt.id} onChange={(event) => setPrompt({ ...prompt, id: event.target.value })} />
        <input className="ob-field" placeholder={t("admin.prompts.title")} value={prompt.title} onChange={(event) => setPrompt({ ...prompt, title: event.target.value })} />
        <select className="ob-field" aria-label={t("admin.prompts.category")} value={prompt.categoryId} onChange={(event) => setPrompt({ ...prompt, categoryId: event.target.value })}><option value="">{t("admin.prompts.uncategorized")}</option>{catalog.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <textarea className="ob-field min-h-24" placeholder={t("admin.prompts.body")} value={prompt.body} onChange={(event) => setPrompt({ ...prompt, body: event.target.value })} />
        <input className="ob-field" placeholder={t("admin.prompts.tags")} value={prompt.tags} onChange={(event) => setPrompt({ ...prompt, tags: event.target.value })} />
      </div>
      <button className="ob-btn" type="button" onClick={() => void perform(async () => { const input = { ...prompt, tags: prompt.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }; await (promptEditing ? updateAdminPrompt(input) : createAdminPrompt(input)); setPrompt({ id: "", title: "", body: "", categoryId: "", tags: "" }); setPromptEditing(false); })}>{promptEditing ? t("admin.prompts.savePrompt") : t("admin.prompts.newPrompt")}</button>
      <div className="grid gap-2 md:grid-cols-3">
        <input className="ob-field" aria-label={t("admin.prompts.search")} placeholder={t("admin.prompts.searchPlaceholder")} value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
        <select className="ob-field" aria-label={t("admin.prompts.categoryFilter")} value={filter.categoryId} onChange={(event) => setFilter({ ...filter, categoryId: event.target.value })}>
          <option value="">{t("admin.prompts.allCategories")}</option>
          <option value={UNCATEGORIZED_FILTER}>{t("admin.prompts.uncategorized")}</option>
          {catalog.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select className="ob-field" aria-label={t("admin.prompts.tagFilter")} value={filter.tag} onChange={(event) => setFilter({ ...filter, tag: event.target.value })}>
          <option value="">{t("admin.prompts.allTags")}</option>
          {[...new Set(catalog.prompts.flatMap((item) => item.tags))].sort().map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </div>
      <p className="text-xs text-[var(--ob-muted)]">{t("admin.prompts.summary", { total: catalog.prompts.length, visible: visiblePrompts.length })}</p>
      <div className="space-y-1">{visiblePrompts.map((item) => <div className="flex items-start gap-2 rounded-lg border border-[var(--ob-line)] p-2" key={item.id}><input aria-label={t("admin.prompts.selectPrompt", { title: item.title })} type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span className="min-w-0 flex-1"><b>{item.title}</b><span className="block text-xs text-[var(--ob-muted)]">{item.body}</span></span>{!item.sourceId ? <button className="ob-btn" type="button" onClick={() => { setPrompt({ id: item.id, title: item.title, body: item.body, categoryId: item.categoryId ?? "", tags: item.tags.join(", ") }); setPromptEditing(true); }}>{t("admin.prompts.edit")}</button> : null}</div>)}</div>
      <button className="ob-btn" type="button" disabled={!selected.length} onClick={() => void perform(async () => { await bulkDeleteAdminPrompts(selected); setSelected([]); })}>{t("admin.prompts.deleteBatch")}</button>
    </section>

    <section className="space-y-2">
      <h2 className="font-semibold">{t("admin.prompts.sources")}</h2>
      <p className="text-xs text-[var(--ob-muted)]">{t("admin.prompts.sourcesHint")}</p>
      <div className="grid gap-2 md:grid-cols-4"><input className="ob-field" placeholder={t("admin.prompts.sourceId")} value={source.id} onChange={(event) => setSource({ ...source, id: event.target.value })} /><input className="ob-field" placeholder={t("admin.prompts.sourceName")} value={source.name} onChange={(event) => setSource({ ...source, name: event.target.value })} /><input className="ob-field" placeholder={t("admin.prompts.sourceUrl")} value={source.url} onChange={(event) => setSource({ ...source, url: event.target.value })} /><select className="ob-field" aria-label={t("admin.prompts.format")} value={source.format} onChange={(event) => setSource({ ...source, format: event.target.value === "markdown" ? "markdown" : "json" })}><option value="json">JSON</option><option value="markdown">{t("admin.prompts.markdown")}</option></select></div>
      <button className="ob-btn" type="button" onClick={() => void perform(async () => { await createAdminPromptSource({ ...source, enabled: true, scheduleEnabled: false, intervalMinutes: 0 }); setSource({ id: "", name: "", url: "", format: "json" }); })}>{t("admin.prompts.addSource")}</button>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--ob-muted)]">{t("admin.prompts.builtin")}</span>
        {COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="ob-btn"
            type="button"
            title={preset.description}
            disabled={catalog.sources.some((item) => item.id === preset.id || item.url === preset.source.url)}
            onClick={() => void perform(() => createAdminPromptSource({
              id: preset.id, name: preset.name, url: preset.source.url,
              format: preset.source.format === "markdown" ? "markdown" : "json", enabled: true, scheduleEnabled: false, intervalMinutes: 0,
            }))}
          >
            {t("admin.prompts.add")} {preset.name}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2"><button className="ob-btn" type="button" onClick={() => void perform(syncAllAdminPromptSources)}>{t("admin.prompts.syncAll")}</button><button className="ob-btn" type="button" onClick={() => void perform(runDueAdminPromptSources)}>{t("admin.prompts.runDue")}</button></div>
      <div className="space-y-2">{catalog.sources.map((item) => <PromptSourceRow key={item.id} source={item} perform={perform} />)}</div>
      <div className="space-y-1 text-xs text-[var(--ob-muted)]"><div>{t("admin.prompts.lastRun")}</div>{catalog.syncRuns.slice(-8).reverse().map((run) => <div key={run.id}>{syncRunSummary(run)}</div>)}{catalog.syncRuns.length ? null : <div>{t("admin.prompts.none")}</div>}</div>
    </section>
  </div>;
}

function PromptSourceRow({ source, perform }: { source: AdminPromptSource; perform: (action: () => Promise<unknown>) => Promise<void> }) {
  const { locale, t } = useI18n();
  const [interval, setIntervalValue] = useState(source.intervalMinutes || 30);
  return <div className="grid gap-2 rounded-xl border border-[var(--ob-line)] p-3 md:grid-cols-[1fr_auto_auto_auto] md:items-center"><div><b>{source.name}</b><div className="text-xs text-[var(--ob-muted)]">{source.url} · {source.format.toUpperCase()} · {source.scheduleStatus || "disabled"}{source.nextRunAt ? ` · ${new Date(source.nextRunAt).toLocaleString(locale)}` : ""}</div></div><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={Boolean(source.scheduleEnabled)} onChange={(event) => void perform(() => updateAdminPromptSource({ ...source, scheduleEnabled: event.target.checked, intervalMinutes: event.target.checked ? interval : 0 }))} />{t("admin.prompts.schedule")}</label><input className="ob-field w-24" aria-label={`${source.name} ${t("admin.prompts.interval")}`} type="number" min={5} max={10080} value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} onBlur={() => { if (source.scheduleEnabled) void perform(() => updateAdminPromptSource({ ...source, scheduleEnabled: true, intervalMinutes: interval })); }} /><div className="flex gap-1"><button className="ob-btn" type="button" onClick={() => void perform(() => syncAdminPromptSource(source.id))}>{t("admin.prompts.sync")}</button><button className="ob-btn" type="button" onClick={() => void perform(() => deleteAdminPromptSource(source.id))}>{t("admin.prompts.delete")}</button></div></div>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

export function syncRunSummary(run: { sourceId: string; status: string; itemCount: number; error?: string }): string {
  return `${run.sourceId} · ${run.status} · ${run.itemCount}${run.error ? ` · ${run.error}` : ""}`;
}
