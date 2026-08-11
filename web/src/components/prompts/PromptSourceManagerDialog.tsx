import { useState } from "react";
import { Eye, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import type {
  PromptItem,
  PromptSourceConfig,
  PromptSourceHtmlMapping,
  PromptSourceMapping,
} from "@/types/board";
import { uid } from "@/lib/id";
import { parsePromptSourceConfig } from "@/services/prompt-sources";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

type Props = {
  open: boolean;
  sources: PromptSourceConfig[];
  busy: boolean;
  onClose: () => void;
  onSave: (source: PromptSourceConfig) => Promise<void> | void;
  onPreview: (source: PromptSourceConfig) => Promise<PromptItem[]>;
  onRefresh: (source: PromptSourceConfig) => Promise<void>;
  onRemove: (source: PromptSourceConfig) => Promise<boolean | void> | boolean | void;
};

const JSON_FIELDS: Array<[keyof PromptSourceMapping, MessageKey, string]> = [
  ["itemsPath", "promptSources.itemsPath", "payload.entries"],
  ["idPath", "promptSources.idPath", "slug"],
  ["titlePath", "promptSources.titlePath", "title"],
  ["bodyPath", "promptSources.bodyPath", "prompt"],
  ["tagsPath", "promptSources.tagsPath", "metadata.tags"],
  ["coverUrlPath", "promptSources.coverUrlPath", "media.cover"],
  ["resultUrlsPath", "promptSources.resultUrlsPath", "media.results"],
];

const HTML_FIELDS: Array<[keyof PromptSourceHtmlMapping, MessageKey, string]> = [
  ["itemSelector", "promptSources.itemSelector", ".prompt-card"],
  ["titleSelector", "promptSources.titleSelector", ".title"],
  ["bodySelector", "promptSources.bodySelector", ".prompt"],
  ["tagsSelector", "promptSources.tagsSelector", ".tag"],
  ["coverSelector", "promptSources.coverSelector", "img.cover"],
  ["resultSelector", "promptSources.resultSelector", ".results img"],
];

function newSource(): PromptSourceConfig {
  return {
    id: uid("prompt-source"),
    name: "",
    url: "",
    format: "auto",
    enabled: true,
    refreshMinutes: 0,
  };
}

function cloneSource(source: PromptSourceConfig): PromptSourceConfig {
  return {
    ...source,
    mapping: source.mapping ? { ...source.mapping } : undefined,
    html: source.html ? { ...source.html } : undefined,
    script: source.script,
  };
}

export function PromptSourceManagerDialog({
  open,
  sources,
  busy,
  onClose,
  onSave,
  onPreview,
  onRefresh,
  onRemove,
}: Props) {
  const { locale, t } = useI18n();
  const [draft, setDraft] = useState<PromptSourceConfig>(() => {
    const custom = sources.find((source) => !source.builtIn);
    return custom ? cloneSource(custom) : newSource();
  });
  const [preview, setPreview] = useState<PromptItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const persisted = sources.some((source) => source.id === draft.id);
  const draftIsBuiltIn = draft.builtIn === true || sources.some((source) =>
    source.id === draft.id && source.builtIn);

  if (!open) return null;

  const validate = () => parsePromptSourceConfig(draft);
  const updateMapping = (key: keyof PromptSourceMapping, value: string) => {
    setDraft((current) => ({
      ...current,
      mapping: { ...current.mapping, [key]: value || undefined },
    }));
  };
  const updateHtml = (key: keyof PromptSourceHtmlMapping, value: string) => {
    setDraft((current) => ({
      ...current,
      html: {
        itemSelector: current.html?.itemSelector ?? "",
        bodySelector: current.html?.bodySelector ?? "",
        ...current.html,
        [key]: value || undefined,
      },
    }));
  };

  return (
    <div className="ob-overlay z-[120] p-3" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-source-manager-title"
        className="ob-dialog flex flex-col max-w-5xl"
      >
        <header className="ob-dialog-header px-4 py-3">
          <h2 id="prompt-source-manager-title" className="text-base font-semibold">{t("promptSources.title")}</h2>
          <button type="button" className="ob-btn-ghost ml-auto p-1" title={t("promptSources.close")} onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-auto border-b border-[var(--ob-line)] p-2 md:border-b-0 md:border-r">
            <button
              type="button"
              className="ob-btn mb-2 w-full justify-center gap-1.5 text-sm"
              onClick={() => {
                setDraft(newSource());
                setPreview([]);
                setError(null);
              }}
            >
              <Plus size={15} /> {t("promptSources.new")}
            </button>
            <div className="space-y-1" role="list" aria-label={t("promptSources.list")}>
              {sources.map((source) => (
                <div key={source.id} role="listitem">
                  <button
                    type="button"
                    className={`w-full rounded-sm px-3 py-2 text-left ${source.id === draft.id ? "bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]" : "hover:bg-[var(--ob-canvas)]"}`}
                    onClick={() => {
                      setDraft(cloneSource(source));
                      setPreview([]);
                      setError(null);
                    }}
                  >
                    <span className="block truncate text-sm font-medium">{source.name}</span>
                    <span className="block truncate text-[11px] text-[var(--ob-muted)]">
                      {source.format} · {source.enabled ? t("promptSources.enabled") : t("promptSources.disabled")}
                      {typeof source.itemCount === "number" ? ` · ${t("promptSources.items", { count: source.itemCount })}` : ""}
                      {` · ${source.lastError ? t("promptSources.failed") : source.lastSuccessAt ? t("promptSources.healthy") : t("promptSources.notSynced")}`}
                    </span>
                    {source.lastSuccessAt ? (
                      <span className="block truncate text-[10px] text-[var(--ob-muted)]">
                        {t("promptSources.lastSuccess", { time: new Date(source.lastSuccessAt).toLocaleString(locale) })}
                      </span>
                    ) : null}
                  </button>
                </div>
              ))}
              {!sources.length ? <p className="px-2 py-5 text-center text-xs text-[var(--ob-muted)]">{t("promptSources.empty")}</p> : null}
            </div>
          </aside>

          <div className="min-h-0 overflow-auto p-4">
            {draftIsBuiltIn ? (
              <p className="mb-3 rounded-sm border border-[var(--ob-line)] bg-[var(--ob-canvas)] px-3 py-2 text-xs text-[var(--ob-muted)]">
                {t("promptSources.builtinHint")}
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">{t("promptSources.name")}
                <input aria-label={t("promptSources.name")} className="ob-field mt-1 disabled:opacity-60" maxLength={120} value={draft.name} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="text-sm">{t("promptSources.format")}
                <select aria-label={t("promptSources.format")} className="ob-field mt-1 disabled:opacity-60" value={draft.format} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({
                  ...current,
                  format: event.target.value as PromptSourceConfig["format"],
                  html: event.target.value === "html" ? current.html ?? { itemSelector: "", bodySelector: "" } : current.html,
                  script: event.target.value === "script"
                    ? (current.script ?? "const data = helpers.parseJson(text);\nreturn Array.isArray(data) ? data : (data.items ?? data.prompts ?? []);")
                    : current.script,
                }))}>
                  <option value="auto">{t("promptSources.auto")}</option>
                  <option value="json">{t("promptSources.json")}</option>
                  <option value="markdown">{t("promptSources.markdown")}</option>
                  <option value="html">{t("promptSources.html")}</option>
                  <option value="script">{t("promptSources.script")}</option>
                </select>
              </label>
              <label className="text-sm sm:col-span-2">{t("promptSources.url")}
                <input aria-label={t("promptSources.url")} className="ob-field mt-1 disabled:opacity-60" placeholder={t("promptSources.urlPlaceholder")} value={draft.url} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />
              </label>
              <label className="text-sm sm:col-span-2">{t("promptSources.homepage")}
                <input aria-label={t("promptSources.homepage")} className="ob-field mt-1 disabled:opacity-60" placeholder="https://github.com/..." value={draft.homepage ?? ""} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({ ...current, homepage: event.target.value || undefined }))} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
                {t("promptSources.enable")}
              </label>
              <label className="text-sm">{t("promptSources.refreshInterval")}
                <select aria-label={t("promptSources.refreshIntervalLabel")} className="ob-field ml-2 w-auto" value={draft.refreshMinutes} onChange={(event) => setDraft((current) => ({ ...current, refreshMinutes: Number(event.target.value) }))}>
                  <option value={0}>{t("promptSources.refreshOff")}</option>
                  <option value={5}>{t("promptSources.minutes", { count: 5 })}</option>
                  <option value={15}>{t("promptSources.minutes", { count: 15 })}</option>
                  <option value={30}>{t("promptSources.minutes", { count: 30 })}</option>
                  <option value={60}>{t("promptSources.hours", { count: 1 })}</option>
                  <option value={360}>{t("promptSources.hours", { count: 6 })}</option>
                  <option value={1440}>{t("promptSources.daily")}</option>
                </select>
              </label>
            </div>

            {!draftIsBuiltIn && (draft.format === "json" || draft.format === "auto") ? (
              <fieldset className="mt-5 border-t border-[var(--ob-line)] pt-4">
                <legend className="px-1 text-sm font-medium">{t("promptSources.jsonMapping")}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {JSON_FIELDS.map(([key, labelKey, placeholder]) => (
                    <label key={key} className="text-xs text-[var(--ob-muted)]">{t(labelKey)}
                      <input aria-label={t(labelKey)} className="ob-field mt-1" placeholder={placeholder} value={draft.mapping?.[key] ?? ""} onChange={(event) => updateMapping(key, event.target.value)} />
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            {!draftIsBuiltIn && draft.format === "html" ? (
              <fieldset className="mt-5 border-t border-[var(--ob-line)] pt-4">
                <legend className="px-1 text-sm font-medium">{t("promptSources.htmlSelectors")}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {HTML_FIELDS.map(([key, labelKey, placeholder]) => (
                    <label key={key} className="text-xs text-[var(--ob-muted)]">{t(labelKey)}
                      <input aria-label={t(labelKey)} className="ob-field mt-1" placeholder={placeholder} value={draft.html?.[key] ?? ""} onChange={(event) => updateHtml(key, event.target.value)} />
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            {!draftIsBuiltIn && draft.format === "script" ? (
              <fieldset className="mt-5 border-t border-[var(--ob-line)] pt-4">
                <legend className="px-1 text-sm font-medium">{t("promptSources.customScript")}</legend>
                <p className="mb-2 text-xs text-[var(--ob-muted)]">
                  {t("promptSources.scriptHint")}
                </p>
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="ob-btn px-2 py-1 text-xs"
                    onClick={() => setDraft((current) => ({
                      ...current,
                      script: "const data = helpers.parseJson(text);\nreturn Array.isArray(data)\n  ? data\n  : (data.items ?? data.prompts ?? []);",
                    }))}
                  >
                    {t("promptSources.insertSyncTemplate")}
                  </button>
                  <button
                    type="button"
                    className="ob-btn px-2 py-1 text-xs"
                    onClick={() => setDraft((current) => ({
                      ...current,
                      script: "const textBody = await helpers.fetchText(url);\nconst data = helpers.parseJson(textBody);\nreturn (Array.isArray(data) ? data : (data.items ?? data.prompts ?? [])).map((item) => ({\n  id: item.id,\n  title: item.title ?? item.name,\n  body: item.prompt ?? item.body ?? item.content,\n  tags: item.tags,\n  coverUrl: item.coverUrl,\n}));",
                    }))}
                  >
                    {t("promptSources.insertAsyncTemplate")}
                  </button>
                </div>
                <textarea
                  aria-label={t("promptSources.scriptLabel")}
                  className="ob-field min-h-48 font-mono text-xs"
                  spellCheck={false}
                  value={draft.script ?? ""}
                  onChange={(event) => setDraft((current) => ({ ...current, script: event.target.value }))}
                  placeholder={"const data = helpers.parseJson(text);\nreturn (data.items ?? []).map((item) => ({\n  id: item.id,\n  title: item.title,\n  body: item.prompt,\n  tags: item.tags,\n}));"}
                />
              </fieldset>
            ) : null}

            {error ? <p role="alert" className="mt-3 text-sm text-[var(--ob-danger)]">{error}</p> : null}
            {preview.length ? (
              <div className="mt-4 border-t border-[var(--ob-line)] pt-3">
                <p className="mb-2 text-xs text-[var(--ob-muted)]">{t("promptSources.previewSummary", { count: preview.length })}</p>
                <ul className="divide-y divide-[var(--ob-line)]" aria-label={t("promptSources.previewList")}>
                  {preview.slice(0, 10).map((item) => (
                    <li key={`${item.id}-${item.title}`} className="py-2">
                      <strong className="block text-sm">{item.title}</strong>
                      <span className="line-clamp-2 text-xs text-[var(--ob-muted)]">{item.body}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="ob-dialog-footer flex-wrap items-center gap-2 px-4 py-3">
          {persisted && !draftIsBuiltIn ? (
            <button type="button" disabled={busy || working} className="ob-btn-danger grid h-9 w-9 place-items-center disabled:opacity-50" title={t("promptSources.delete")} onClick={() => {
              setWorking(true);
              setError(null);
              void Promise.resolve(onRemove(draft)).then((removed) => {
                if (removed === false) return;
                const next = sources.find((source) => source.id !== draft.id);
                setDraft(next ? cloneSource(next) : newSource());
                setPreview([]);
              }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setWorking(false));
            }}>
              <Trash2 size={16} />
            </button>
          ) : null}
          <button type="button" disabled={busy || working} className="ob-btn ml-auto gap-1.5 text-sm disabled:opacity-50" onClick={() => {
            try {
              const valid = validate();
              setError(null);
              void onPreview(valid).then(setPreview).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}><Eye size={15} /> {t("promptSources.preview")}</button>
          {persisted ? <button type="button" disabled={busy || working} className="ob-btn gap-1.5 text-sm disabled:opacity-50" onClick={() => {
            try {
              const valid = validate();
              setError(null);
              void onRefresh(valid).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}><RefreshCw size={15} /> {t("promptSources.refresh")}</button> : null}
          <button type="button" disabled={busy || working} className="ob-btn-primary gap-1.5 text-sm disabled:opacity-50" onClick={() => {
            try {
              const valid = validate();
              setError(null);
              setWorking(true);
              void Promise.resolve(onSave(valid))
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setWorking(false));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}><Save size={15} /> {t("promptSources.save")}</button>
        </footer>
      </section>
    </div>
  );
}
