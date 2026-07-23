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

const JSON_FIELDS: Array<[keyof PromptSourceMapping, string, string]> = [
  ["itemsPath", "条目路径", "payload.entries"],
  ["idPath", "ID 路径", "slug"],
  ["titlePath", "标题路径", "title"],
  ["bodyPath", "正文路径", "prompt"],
  ["tagsPath", "标签路径", "metadata.tags"],
  ["coverUrlPath", "封面路径", "media.cover"],
  ["resultUrlsPath", "结果图路径", "media.results"],
];

const HTML_FIELDS: Array<[keyof PromptSourceHtmlMapping, string, string]> = [
  ["itemSelector", "条目选择器", ".prompt-card"],
  ["titleSelector", "标题选择器", ".title"],
  ["bodySelector", "正文选择器", ".prompt"],
  ["tagsSelector", "标签选择器", ".tag"],
  ["coverSelector", "封面选择器", "img.cover"],
  ["resultSelector", "结果图选择器", ".results img"],
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
          <h2 id="prompt-source-manager-title" className="text-base font-semibold">管理提示词来源</h2>
          <button type="button" className="ob-btn-ghost ml-auto p-1" title="关闭来源管理" onClick={onClose}>
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
              <Plus size={15} /> 新增来源
            </button>
            <div className="space-y-1" role="list" aria-label="提示词来源列表">
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
                      {source.format} · {source.enabled ? "已启用" : "已停用"}
                      {typeof source.itemCount === "number" ? ` · ${source.itemCount} 条` : ""}
                      {source.lastError ? " · 失败" : source.lastSuccessAt ? " · 正常" : " · 未同步"}
                    </span>
                    {source.lastSuccessAt ? (
                      <span className="block truncate text-[10px] text-[var(--ob-muted)]">
                        上次成功 {new Date(source.lastSuccessAt).toLocaleString()}
                      </span>
                    ) : null}
                  </button>
                </div>
              ))}
              {!sources.length ? <p className="px-2 py-5 text-center text-xs text-[var(--ob-muted)]">暂无远程来源</p> : null}
            </div>
          </aside>

          <div className="min-h-0 overflow-auto p-4">
            {draftIsBuiltIn ? (
              <p className="mb-3 rounded-sm border border-[var(--ob-line)] bg-[var(--ob-canvas)] px-3 py-2 text-xs text-[var(--ob-muted)]">
                内置 Image Prompts 来源的地址与映射由注册表维护，仅可启用/停用和设置自动刷新。
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">来源名称
                <input aria-label="来源名称" className="ob-field mt-1 disabled:opacity-60" maxLength={120} value={draft.name} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="text-sm">解析格式
                <select aria-label="来源解析格式" className="ob-field mt-1 disabled:opacity-60" value={draft.format} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({
                  ...current,
                  format: event.target.value as PromptSourceConfig["format"],
                  html: event.target.value === "html" ? current.html ?? { itemSelector: "", bodySelector: "" } : current.html,
                  script: event.target.value === "script"
                    ? (current.script ?? "const data = helpers.parseJson(text);\nreturn Array.isArray(data) ? data : (data.items ?? data.prompts ?? []);")
                    : current.script,
                }))}>
                  <option value="auto">自动识别</option>
                  <option value="json">JSON</option>
                  <option value="markdown">Markdown</option>
                  <option value="html">HTML</option>
                  <option value="script">脚本转换</option>
                </select>
              </label>
              <label className="text-sm sm:col-span-2">来源 URL
                <input aria-label="来源 URL" className="ob-field mt-1 disabled:opacity-60" placeholder="https://example.com/prompts.json 或 Image Prompts 标准 JSON" value={draft.url} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />
              </label>
              <label className="text-sm sm:col-span-2">主页（可选）
                <input aria-label="来源主页" className="ob-field mt-1 disabled:opacity-60" placeholder="https://github.com/..." value={draft.homepage ?? ""} disabled={draftIsBuiltIn} onChange={(event) => setDraft((current) => ({ ...current, homepage: event.target.value || undefined }))} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
                启用来源
              </label>
              <label className="text-sm">自动刷新
                <select aria-label="自动刷新周期" className="ob-field ml-2 w-auto" value={draft.refreshMinutes} onChange={(event) => setDraft((current) => ({ ...current, refreshMinutes: Number(event.target.value) }))}>
                  <option value={0}>关闭</option>
                  <option value={5}>5 分钟</option>
                  <option value={15}>15 分钟</option>
                  <option value={30}>30 分钟</option>
                  <option value={60}>1 小时</option>
                  <option value={360}>6 小时</option>
                  <option value={1440}>每天</option>
                </select>
              </label>
            </div>

            {!draftIsBuiltIn && (draft.format === "json" || draft.format === "auto") ? (
              <fieldset className="mt-5 border-t border-[var(--ob-line)] pt-4">
                <legend className="px-1 text-sm font-medium">JSON 字段映射</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {JSON_FIELDS.map(([key, label, placeholder]) => (
                    <label key={key} className="text-xs text-[var(--ob-muted)]">{label}
                      <input aria-label={label} className="ob-field mt-1" placeholder={placeholder} value={draft.mapping?.[key] ?? ""} onChange={(event) => updateMapping(key, event.target.value)} />
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            {!draftIsBuiltIn && draft.format === "html" ? (
              <fieldset className="mt-5 border-t border-[var(--ob-line)] pt-4">
                <legend className="px-1 text-sm font-medium">HTML 选择器</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {HTML_FIELDS.map(([key, label, placeholder]) => (
                    <label key={key} className="text-xs text-[var(--ob-muted)]">{label}
                      <input aria-label={label} className="ob-field mt-1" placeholder={placeholder} value={draft.html?.[key] ?? ""} onChange={(event) => updateHtml(key, event.target.value)} />
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            {!draftIsBuiltIn && draft.format === "script" ? (
              <fieldset className="mt-5 border-t border-[var(--ob-line)] pt-4">
                <legend className="px-1 text-sm font-medium">自定义抓取脚本</legend>
                <p className="mb-2 text-xs text-[var(--ob-muted)]">
                  本地执行：参数为 <code>text</code>（来源 URL 正文，可空）、<code>url</code>、<code>helpers</code>。
                  可同步或 <code>async</code> <code>return</code> 提示词数组；每项至少含 <code>title</code>/<code>body</code>（或 <code>prompt</code>）。
                  helpers：<code>parseJson</code>、<code>fetchText</code>、<code>fetchJson</code>、<code>queryAll</code>、<code>absoluteUrl</code>。
                  支持本机 <code>http://127.0.0.1</code> / <code>localhost</code> 源。
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
                    插入同步模板
                  </button>
                  <button
                    type="button"
                    className="ob-btn px-2 py-1 text-xs"
                    onClick={() => setDraft((current) => ({
                      ...current,
                      script: "const textBody = await helpers.fetchText(url);\nconst data = helpers.parseJson(textBody);\nreturn (Array.isArray(data) ? data : (data.items ?? data.prompts ?? [])).map((item) => ({\n  id: item.id,\n  title: item.title ?? item.name,\n  body: item.prompt ?? item.body ?? item.content,\n  tags: item.tags,\n  coverUrl: item.coverUrl,\n}));",
                    }))}
                  >
                    插入异步抓取模板
                  </button>
                </div>
                <textarea
                  aria-label="转换脚本"
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
                <p className="mb-2 text-xs text-[var(--ob-muted)]">预览 {preview.length} 条，显示前 10 条</p>
                <ul className="divide-y divide-[var(--ob-line)]" aria-label="来源预览">
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
            <button type="button" disabled={busy || working} className="ob-btn-danger grid h-9 w-9 place-items-center disabled:opacity-50" title="删除来源" onClick={() => {
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
          }}><Eye size={15} /> 预览</button>
          {persisted ? <button type="button" disabled={busy || working} className="ob-btn gap-1.5 text-sm disabled:opacity-50" onClick={() => {
            try {
              const valid = validate();
              setError(null);
              void onRefresh(valid).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}><RefreshCw size={15} /> 刷新</button> : null}
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
          }}><Save size={15} /> 保存来源</button>
        </footer>
      </section>
    </div>
  );
}
