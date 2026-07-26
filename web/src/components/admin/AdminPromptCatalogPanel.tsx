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
  const [catalog, setCatalog] = useState(EMPTY);
  const [error, setError] = useState("");
  const [category, setCategory] = useState({ id: "", name: "", order: 0 });
  const [categoryEditing, setCategoryEditing] = useState(false);
  const [prompt, setPrompt] = useState({ id: "", title: "", body: "", categoryId: "", tags: "" });
  const [promptEditing, setPromptEditing] = useState(false);
  const [source, setSource] = useState({ id: "", name: "", url: "" });
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
      <h2 className="font-semibold">分类与条目</h2>
      <div className="flex flex-wrap gap-2">
        <input className="ob-field max-w-48" placeholder="分类 ID" value={category.id} onChange={(event) => setCategory({ ...category, id: event.target.value })} />
        <input className="ob-field max-w-48" placeholder="分类名称" value={category.name} onChange={(event) => setCategory({ ...category, name: event.target.value })} />
        <input className="ob-field w-24" aria-label="分类排序" type="number" value={category.order} onChange={(event) => setCategory({ ...category, order: Number(event.target.value) })} />
        <button className="ob-btn" type="button" onClick={() => void perform(async () => { await (categoryEditing ? updateAdminPromptCategory(category) : createAdminPromptCategory(category)); setCategory({ id: "", name: "", order: 0 }); setCategoryEditing(false); })}>{categoryEditing ? "保存分类" : "新增分类"}</button>
      </div>
      <div className="flex flex-wrap gap-2">{catalog.categories.map((item) => <span className="ob-chip" key={item.id}>{item.name}<button className="ml-2" type="button" onClick={() => { setCategory(item); setCategoryEditing(true); }}>编辑</button><button className="ml-2" type="button" aria-label={`删除分类 ${item.name}`} onClick={() => void perform(() => deleteAdminPromptCategory(item.id))}>×</button></span>)}</div>
      <div className="grid gap-2 md:grid-cols-2">
        <input className="ob-field" placeholder="提示词 ID" value={prompt.id} onChange={(event) => setPrompt({ ...prompt, id: event.target.value })} />
        <input className="ob-field" placeholder="标题" value={prompt.title} onChange={(event) => setPrompt({ ...prompt, title: event.target.value })} />
        <select className="ob-field" aria-label="提示词分类" value={prompt.categoryId} onChange={(event) => setPrompt({ ...prompt, categoryId: event.target.value })}><option value="">未分类</option>{catalog.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <textarea className="ob-field min-h-24" placeholder="提示词正文" value={prompt.body} onChange={(event) => setPrompt({ ...prompt, body: event.target.value })} />
        <input className="ob-field" placeholder="标签，逗号分隔" value={prompt.tags} onChange={(event) => setPrompt({ ...prompt, tags: event.target.value })} />
      </div>
      <button className="ob-btn" type="button" onClick={() => void perform(async () => { const input = { ...prompt, tags: prompt.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }; await (promptEditing ? updateAdminPrompt(input) : createAdminPrompt(input)); setPrompt({ id: "", title: "", body: "", categoryId: "", tags: "" }); setPromptEditing(false); })}>{promptEditing ? "保存提示词" : "新增提示词"}</button>
      <div className="grid gap-2 md:grid-cols-3">
        <input className="ob-field" aria-label="搜索提示词" placeholder="按标题、正文或标签搜索" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
        <select className="ob-field" aria-label="按分类筛选" value={filter.categoryId} onChange={(event) => setFilter({ ...filter, categoryId: event.target.value })}>
          <option value="">全部分类</option>
          <option value={UNCATEGORIZED_FILTER}>未分类</option>
          {catalog.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select className="ob-field" aria-label="按标签筛选" value={filter.tag} onChange={(event) => setFilter({ ...filter, tag: event.target.value })}>
          <option value="">全部标签</option>
          {[...new Set(catalog.prompts.flatMap((item) => item.tags))].sort().map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </div>
      <p className="text-xs text-[var(--ob-muted)]">共 {catalog.prompts.length} 条，当前显示 {visiblePrompts.length} 条。</p>
      <div className="space-y-1">{visiblePrompts.map((item) => <div className="flex items-start gap-2 rounded-lg border border-[var(--ob-line)] p-2" key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span className="min-w-0 flex-1"><b>{item.title}</b><span className="block text-xs text-[var(--ob-muted)]">{item.body}</span></span>{!item.sourceId ? <button className="ob-btn" type="button" onClick={() => { setPrompt({ id: item.id, title: item.title, body: item.body, categoryId: item.categoryId ?? "", tags: item.tags.join(", ") }); setPromptEditing(true); }}>编辑</button> : null}</div>)}</div>
      <button className="ob-btn" type="button" disabled={!selected.length} onClick={() => void perform(async () => { await bulkDeleteAdminPrompts(selected); setSelected([]); })}>批量删除</button>
    </section>

    <section className="space-y-2">
      <h2 className="font-semibold">JSON 来源与调度</h2>
      <p className="text-xs text-[var(--ob-muted)]">服务端调度采用持久化 nextRunAt；当前由管理员点击“运行到期任务”触发，适合外部定时器调用同一受保护接口。</p>
      <div className="grid gap-2 md:grid-cols-3"><input className="ob-field" placeholder="来源 ID" value={source.id} onChange={(event) => setSource({ ...source, id: event.target.value })} /><input className="ob-field" placeholder="来源名称" value={source.name} onChange={(event) => setSource({ ...source, name: event.target.value })} /><input className="ob-field" placeholder="https://…/prompts.json" value={source.url} onChange={(event) => setSource({ ...source, url: event.target.value })} /></div>
      <button className="ob-btn" type="button" onClick={() => void perform(() => createAdminPromptSource({ ...source, format: "json", enabled: true, scheduleEnabled: false, intervalMinutes: 0 }))}>新增来源</button>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--ob-muted)]">内置来源：</span>
        {COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="ob-btn"
            type="button"
            title={preset.description}
            disabled={catalog.sources.some((item) => item.id === preset.id || item.url === preset.source.url)}
            onClick={() => void perform(() => createAdminPromptSource({
              id: preset.id, name: preset.name, url: preset.source.url,
              format: "json", enabled: true, scheduleEnabled: false, intervalMinutes: 0,
            }))}
          >
            添加 {preset.name}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2"><button className="ob-btn" type="button" onClick={() => void perform(syncAllAdminPromptSources)}>同步全部</button><button className="ob-btn" type="button" onClick={() => void perform(runDueAdminPromptSources)}>运行到期任务</button></div>
      <div className="space-y-2">{catalog.sources.map((item) => <PromptSourceRow key={item.id} source={item} perform={perform} />)}</div>
      <div className="space-y-1 text-xs text-[var(--ob-muted)]"><div>最近运行</div>{catalog.syncRuns.slice(-8).reverse().map((run) => <div key={run.id}>{syncRunSummary(run)}</div>)}{catalog.syncRuns.length ? null : <div>暂无</div>}</div>
    </section>
  </div>;
}

function PromptSourceRow({ source, perform }: { source: AdminPromptSource; perform: (action: () => Promise<unknown>) => Promise<void> }) {
  const [interval, setIntervalValue] = useState(source.intervalMinutes || 30);
  return <div className="grid gap-2 rounded-xl border border-[var(--ob-line)] p-3 md:grid-cols-[1fr_auto_auto_auto] md:items-center"><div><b>{source.name}</b><div className="text-xs text-[var(--ob-muted)]">{source.url} · {source.scheduleStatus || "disabled"}{source.nextRunAt ? ` · ${new Date(source.nextRunAt).toLocaleString()}` : ""}</div></div><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={Boolean(source.scheduleEnabled)} onChange={(event) => void perform(() => updateAdminPromptSource({ ...source, scheduleEnabled: event.target.checked, intervalMinutes: event.target.checked ? interval : 0 }))} />定时</label><input className="ob-field w-24" aria-label={`${source.name} 同步间隔`} type="number" min={5} max={10080} value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} onBlur={() => { if (source.scheduleEnabled) void perform(() => updateAdminPromptSource({ ...source, scheduleEnabled: true, intervalMinutes: interval })); }} /><div className="flex gap-1"><button className="ob-btn" type="button" onClick={() => void perform(() => syncAdminPromptSource(source.id))}>同步</button><button className="ob-btn" type="button" onClick={() => void perform(() => deleteAdminPromptSource(source.id))}>删除</button></div></div>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

export function syncRunSummary(run: { sourceId: string; status: string; itemCount: number; error?: string }): string {
  return `${run.sourceId} · ${run.status} · ${run.itemCount}${run.error ? ` · ${run.error}` : ""}`;
}
