import { useCallback, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { createDefaultChannel } from "@/lib/defaults";
import { listModels } from "@/services/ai-client";
import { webdavGetBlob, webdavPutBlob } from "@/services/webdav";
import { exportProjectBundle, importProjectBundle } from "@/lib/project-bundle";
import { exportWorkspaceBundle, importWorkspaceBundle } from "@/lib/workspace-bundle";
import { getProvider, normalizeChannel } from "@/lib/ai-config";
import type { AiProviderKind } from "@/types/board";
import type { AiTemplateConfig } from "@/types/board";
import { validateProviderTemplate } from "@/lib/provider-template";
import { SYSTEM_PROMPT_MAX_LENGTH } from "@/lib/app-config";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { listAllGenerationJobs } from "@/services/generation-jobs";
import {
  AudioLines,
  CloudDownload,
  CloudUpload,
  Film,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Type,
  X,
} from "lucide-react";

const PROVIDER_KINDS: AiProviderKind[] = ["text", "image", "video", "audio"];
const PROVIDER_LABELS: Record<AiProviderKind, string> = {
  text: "文本",
  image: "生图",
  video: "视频",
  audio: "音频",
};

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);
  const flushConfig = useBoardStore((s) => s.flushConfig);
  const [models, setModels] = useState<Partial<Record<AiProviderKind, string[]>>>({});
  const [busyKind, setBusyKind] = useState<AiProviderKind | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    void flushConfig()
      .then(() => {
        setClosing(false);
        onClose();
      })
      .catch((cause) => {
        setClosing(false);
        setError(cause instanceof Error ? cause.message : "配置保存失败");
      });
  }, [closing, flushConfig, onClose]);
  useEscapeDismiss(open, requestClose);

  if (!open) return null;
  const channel =
    config.channels.find((c) => c.id === config.activeChannelId) ?? config.channels[0];

  const updateChannel = (patch: Partial<typeof channel>) => {
    setConfig({
      ...config,
      channels: config.channels.map((c) =>
        c.id === channel.id ? { ...c, ...patch } : c,
      ),
    });
  };

  const updateProvider = (kind: AiProviderKind, patch: Partial<ReturnType<typeof getProvider>>) => {
    const normalized = normalizeChannel(channel);
    updateChannel({ providers: { ...normalized.providers!, [kind]: { ...normalized.providers![kind], ...patch } } });
  };

  const pullModels = async (kind: AiProviderKind) => {
    setBusyKind(kind);
    setError(null);
    try {
      const list = await listModels(channel, kind);
      setModels((current) => ({ ...current, [kind]: list }));
      if (!list.length) setError("未拉取到模型（该服务可能不支持模型列表，请手动填写）");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-2 backdrop-blur-sm sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="ob-surface-glass flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden"
      >
        <header className="flex min-h-16 items-center gap-4 border-b border-[var(--ob-line)] px-4 sm:px-6">
          <div>
            <h2 id="settings-title" className="text-lg font-semibold">设置</h2>
            <p className="text-xs text-[var(--ob-muted)]">本地工作区配置</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            className="ob-icon-btn ml-auto"
            disabled={closing}
            onClick={requestClose}
          >
            {closing ? <RefreshCw className="animate-spin" size={17} /> : <X size={18} />}
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 text-sm sm:px-6">
          <section className="mb-6">
            <SectionTitle title="渠道" />
            <div className="grid gap-3 sm:grid-cols-[minmax(180px,0.8fr)_minmax(240px,1.2fr)_40px]">
              <Field label="当前渠道">
                <select
                  className="field"
                  aria-label="当前渠道"
                  value={config.activeChannelId ?? ""}
                  onChange={(e) => setConfig({ ...config, activeChannelId: e.target.value })}
                >
                  {config.channels.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="渠道名称">
                <input
                  className="field"
                  value={channel.name}
                  onChange={(e) => updateChannel({ name: e.target.value })}
                />
              </Field>
              <button
                type="button"
                aria-label="添加渠道"
                title="添加渠道"
                className="mt-5 grid h-9 w-9 place-items-center rounded-md border border-[var(--ob-line)] hover:bg-[var(--ob-accent-soft)]"
                onClick={() => {
                  const next = createDefaultChannel();
                  setConfig({
                    ...config,
                    channels: [...config.channels, next],
                    activeChannelId: next.id,
                  });
                }}
              >
                <Plus size={17} />
              </button>
            </div>
          </section>

          <section className="mb-6">
            <SectionTitle title="模型服务" />
            <div className="overflow-hidden rounded-md border border-[var(--ob-line)]">
              <div className="hidden grid-cols-[110px_140px_minmax(180px,1.3fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_44px] gap-2 border-b border-[var(--ob-line)] bg-[var(--ob-canvas)] px-3 py-2 text-xs text-[var(--ob-muted)] md:grid">
                <span>能力</span><span>协议</span><span>服务 URL</span><span>API Key</span><span>模型</span><span />
              </div>
              {PROVIDER_KINDS.map((kind) => (
                <ProviderRow
                  key={kind}
                  kind={kind}
                  provider={getProvider(channel, kind)}
                  models={models[kind] ?? []}
                  busy={busyKind === kind}
                  disabled={busyKind !== null}
                  onPull={() => void pullModels(kind)}
                  onChange={(patch) => updateProvider(kind, patch)}
                />
              ))}
            </div>
          </section>

          <section className="mb-6 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
            <div>
              <SectionTitle title="生成偏好" />
              <Field label="全局系统提示词">
                <textarea
                  className="field min-h-28 resize-y"
                  maxLength={SYSTEM_PROMPT_MAX_LENGTH}
                  value={config.systemPrompt}
                  onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
                  placeholder="应用于文本、图片生成和图片编辑请求"
                />
              </Field>
            </div>
            <div className="grid content-start grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-8 lg:grid-cols-1">
              <Field label="图片尺寸">
                <input className="field" value={config.imageSize} onChange={(e) => setConfig({ ...config, imageSize: e.target.value })} />
              </Field>
              <Field label="图片质量">
                <input className="field" value={config.imageQuality} onChange={(e) => setConfig({ ...config, imageQuality: e.target.value })} />
              </Field>
              <Field label="默认数量">
                <input className="field" type="number" min={1} max={8} value={config.imageCount} onChange={(e) => setConfig({ ...config, imageCount: Number(e.target.value) || 1 })} />
              </Field>
            </div>
          </section>

          <section>
            <SectionTitle title="WebDAV 备份" />
            <div className="grid gap-3 lg:grid-cols-[1.4fr_0.7fr_0.7fr]">
              <Field label="WebDAV URL">
                <input className="field" value={config.webdavUrl ?? ""} onChange={(e) => setConfig({ ...config, webdavUrl: e.target.value })} placeholder="https://example.com/dav/openboard" />
              </Field>
              <Field label="用户名">
                <input className="field" value={config.webdavUser ?? ""} onChange={(e) => setConfig({ ...config, webdavUser: e.target.value })} />
              </Field>
              <Field label="密码">
                <input className="field" type="password" value={config.webdavPass ?? ""} onChange={(e) => setConfig({ ...config, webdavPass: e.target.value })} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        const state = useBoardStore.getState();
                        const project = state.getActive();
                        if (!project) throw new Error("当前没有可备份的画布");
                        const bundle = await exportProjectBundle(project);
                        await webdavPutBlob(state.config, "openboard-current.openboard", bundle);
                        alert("已上传当前画布完整备份");
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <CloudUpload size={15} /> 上传当前画布
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        const state = useBoardStore.getState();
                        const bundle = await exportWorkspaceBundle({
                          projects: state.projects,
                          assets: state.assets,
                          prompts: state.prompts,
                          config: state.config,
                          generationJobs: await listAllGenerationJobs(),
                        });
                        await webdavPutBlob(state.config, "openboard-workspace.obundle", bundle);
                        alert("已上传完整工作区备份");
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <CloudUpload size={15} /> 上传完整工作区
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        const state = useBoardStore.getState();
                        const blob = await webdavGetBlob(
                          state.config,
                          "openboard-current.openboard",
                        );
                        state.importProject(await importProjectBundle(blob));
                        alert("已从 WebDAV 导入完整画布备份");
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <CloudDownload size={15} /> 导入云端画布
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        if (!confirm("恢复完整工作区会替换当前项目、素材、提示词和生成历史。继续吗？")) return;
                        const state = useBoardStore.getState();
                        const blob = await webdavGetBlob(state.config, "openboard-workspace.obundle");
                        await importWorkspaceBundle(blob, state.config, undefined, state.replaceWorkspace);
                        alert("已恢复完整工作区");
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <RotateCcw size={15} /> 恢复完整工作区
                </button>
            </div>
          </section>

          {error ? <p role="alert" className="mt-4 rounded-md bg-[color-mix(in_srgb,var(--ob-danger)_12%,transparent)] px-3 py-2 text-[var(--ob-danger)]">{error}</p> : null}
          <div className="mt-5 flex items-start gap-2 border-t border-[var(--ob-line)] pt-4 text-xs text-[var(--ob-muted)]">
            <ShieldCheck className="mt-0.5 shrink-0" size={15} />
            <p>
            {import.meta.env.VITE_OPENBOARD_STORAGE === "server"
              ? "API Key 经本地服务加密后存入 PostgreSQL，数据库中不保存明文。"
              : "API Key 仅保存在当前浏览器的本地存储中。"}
            Ark / Seedance 请为对应服务选择 Ark 协议，并填写兼容的
            `/api/v3` Base URL 与模型名。
            </p>
          </div>
        </div>
      </div>
      <style>{`
        .field { width: 100%; min-height: 36px; border: 1px solid var(--ob-line); border-radius: 6px; padding: 7px 9px; background: var(--ob-panel); color: var(--ob-ink); outline: none; }
        .field:focus { border-color: var(--ob-select); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ob-select) 18%, transparent); }
        .btn { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; border: 1px solid var(--ob-line); border-radius: 6px; padding: 7px 10px; background: transparent; }
        .btn:hover { background: var(--ob-accent-soft); }
      `}</style>
    </div>
  );
}

function ProviderRow({
  kind,
  provider,
  models,
  busy,
  disabled,
  onPull,
  onChange,
}: {
  kind: AiProviderKind;
  provider: ReturnType<typeof getProvider>;
  models: string[];
  busy: boolean;
  disabled: boolean;
  onPull: () => void;
  onChange: (patch: Partial<ReturnType<typeof getProvider>>) => void;
}) {
  const label = PROVIDER_LABELS[kind];
  const Icon = kind === "text" ? Type : kind === "image" ? ImageIcon : kind === "video" ? Film : AudioLines;
  return (
    <div
      className="border-b border-[var(--ob-line)] px-3 py-3 last:border-b-0"
      data-provider-kind={kind}
    >
      <div className="grid gap-2 md:grid-cols-[110px_140px_minmax(180px,1.3fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_44px] md:items-center">
        <div className="flex items-center gap-2 font-medium"><Icon size={16} className="text-[var(--ob-accent)]" />{label}</div>
        <CompactField label="协议">
          <select className="field" aria-label={`${label}协议`} value={provider.protocol} onChange={(e) => onChange({ protocol: e.target.value as typeof provider.protocol })}>
            <option value="openai">OpenAI</option>
            <option value="ark">Ark / Seedance</option>
            <option value="gemini">Gemini</option>
            <option value="template">Template</option>
          </select>
        </CompactField>
        <CompactField label="服务 URL">
          <input className="field" aria-label={`${label} URL`} value={provider.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="服务 URL" />
        </CompactField>
        <CompactField label="API Key">
          <input className="field" aria-label={`${label} API Key`} type="password" value={provider.apiKey} onChange={(e) => onChange({ apiKey: e.target.value })} placeholder="API Key" />
        </CompactField>
        <CompactField label="模型">
          <input className="field" aria-label={`${label}模型`} value={provider.model} onChange={(e) => onChange({ model: e.target.value })} placeholder="模型名称" />
        </CompactField>
        <button type="button" className="grid h-9 w-9 place-items-center rounded-md border border-[var(--ob-line)] hover:bg-[var(--ob-accent-soft)] disabled:opacity-50" aria-label={`拉取${label}模型`} title={`拉取${label}模型`} disabled={disabled} onClick={onPull}>
          <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
        </button>
      </div>
      {provider.protocol === "template" ? <TemplateEditor value={provider.template} onChange={(template) => onChange({ template })} /> : null}
      {models.length ? (
        <div className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-auto pl-0 md:pl-[250px]">
          {models.map((model) => <button key={model} type="button" className="rounded bg-[var(--ob-accent-soft)] px-2 py-1 text-xs" onClick={() => onChange({ model })}>{model}</button>)}
        </div>
      ) : null}
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h3 className="mb-3 text-xs font-semibold uppercase text-[var(--ob-muted)]">{title}</h3>;
}

function CompactField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs text-[var(--ob-muted)] md:hidden">{label}</span>
      {children}
    </label>
  );
}

function TemplateEditor({
  value,
  onChange,
}: {
  value?: AiTemplateConfig;
  onChange: (value: AiTemplateConfig) => void;
}) {
  const fallback: AiTemplateConfig = {
    method: "POST",
    path: "/generate",
    auth: "bearer",
    request: { prompt: "{{prompt}}", model: "{{model}}" },
    responsePath: "data.urls",
  };
  const [source, setSource] = useState(() => JSON.stringify(value ?? fallback, null, 2));
  const [message, setMessage] = useState("");
  return (
    <div className="mt-2">
      <textarea
        aria-label="声明式模板 JSON"
        className="field min-h-40 resize-y font-mono text-xs"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className="btn"
          onClick={() => {
            try {
              const parsed = JSON.parse(source) as AiTemplateConfig;
              validateProviderTemplate(parsed);
              onChange(parsed);
              setMessage("模板已应用");
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          应用模板
        </button>
        {message ? <span className="text-xs text-[var(--ob-muted)]">{message}</span> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[var(--ob-muted)]">{label}</span>
      {children}
    </label>
  );
}
