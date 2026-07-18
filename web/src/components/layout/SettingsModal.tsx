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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-5 shadow-[var(--ob-shadow)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">设置</h2>
          <button
            type="button"
            className="text-[var(--ob-muted)] disabled:opacity-50"
            disabled={closing}
            onClick={requestClose}
          >
            {closing ? "保存中…" : "关闭"}
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <Field label="渠道名称">
            <input
              className="field"
              value={channel.name}
              onChange={(e) => updateChannel({ name: e.target.value })}
            />
          </Field>
          <div className="space-y-3">
            {(["text", "image", "video", "audio"] as AiProviderKind[]).map((kind) => {
              const provider = getProvider(channel, kind);
              const labels = { text: "文本", image: "生图", video: "视频", audio: "音频" };
              return <div key={kind} className="rounded border border-[var(--ob-line)] p-3">
                <h3 className="mb-2 font-medium">{labels[kind]}模型服务</h3>
                <label className="mb-2 flex items-center gap-2">
                  <span className="text-[var(--ob-muted)]">协议</span>
                  <select
                    className="field max-w-40"
                    aria-label={`${labels[kind]}协议`}
                    value={provider.protocol}
                    onChange={(e) => updateProvider(kind, { protocol: e.target.value as typeof provider.protocol })}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="ark">Ark / Seedance</option>
                    <option value="gemini">Gemini</option>
                    <option value="template">Template</option>
                  </select>
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input className="field" aria-label={`${labels[kind]} URL`} value={provider.baseUrl} onChange={(e) => updateProvider(kind, { baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
                  <input className="field" aria-label={`${labels[kind]} API Key`} type="password" value={provider.apiKey} onChange={(e) => updateProvider(kind, { apiKey: e.target.value })} />
                  <input className="field" aria-label={`${labels[kind]}模型`} value={provider.model} onChange={(e) => updateProvider(kind, { model: e.target.value })} />
                </div>
                {provider.protocol === "template" ? (
                  <TemplateEditor
                    value={provider.template}
                    onChange={(template) => updateProvider(kind, { template })}
                  />
                ) : null}
                <button
                  type="button"
                  className="btn mt-2"
                  disabled={busyKind !== null}
                  onClick={() => void pullModels(kind)}
                >
                  {busyKind === kind ? "拉取中…" : `拉取${labels[kind]}模型`}
                </button>
                {models[kind]?.length ? (
                  <div className="mt-2 max-h-28 overflow-auto rounded border border-[var(--ob-line)] p-2 text-xs">
                    {models[kind]!.map((model) => (
                      <button
                        key={model}
                        type="button"
                        className="mr-2 mb-1 rounded bg-[var(--ob-accent-soft)] px-2 py-0.5"
                        onClick={() => updateProvider(kind, { model })}
                      >
                        {model}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>;
            })}
          </div>
          <Field label="全局系统提示词">
            <textarea
              className="field min-h-24 resize-y"
              maxLength={SYSTEM_PROMPT_MAX_LENGTH}
              value={config.systemPrompt}
              onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
              placeholder="应用于文本、图片生成和图片编辑请求"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="图片尺寸">
              <input
                className="field"
                value={config.imageSize}
                onChange={(e) => setConfig({ ...config, imageSize: e.target.value })}
              />
            </Field>
            <Field label="图片质量">
              <input
                className="field"
                value={config.imageQuality}
                onChange={(e) => setConfig({ ...config, imageQuality: e.target.value })}
              />
            </Field>
            <Field label="默认数量">
              <input
                className="field"
                type="number"
                min={1}
                max={8}
                value={config.imageCount}
                onChange={(e) =>
                  setConfig({ ...config, imageCount: Number(e.target.value) || 1 })
                }
              />
            </Field>
          </div>

          <div className="rounded-lg border border-[var(--ob-line)] p-3">
            <div className="mb-2 font-medium">WebDAV 备份（可选）</div>
            <div className="space-y-2">
              <Field label="WebDAV URL">
                <input
                  className="field"
                  value={config.webdavUrl ?? ""}
                  onChange={(e) => setConfig({ ...config, webdavUrl: e.target.value })}
                  placeholder="https://example.com/dav/openboard"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="用户名">
                  <input
                    className="field"
                    value={config.webdavUser ?? ""}
                    onChange={(e) => setConfig({ ...config, webdavUser: e.target.value })}
                  />
                </Field>
                <Field label="密码">
                  <input
                    className="field"
                    type="password"
                    value={config.webdavPass ?? ""}
                    onChange={(e) => setConfig({ ...config, webdavPass: e.target.value })}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
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
                  上传当前画布
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
                  上传完整工作区
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
                  导入云端画布
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
                  恢复完整工作区
                </button>
              </div>
              <p className="text-xs text-[var(--ob-muted)]">
                浏览器直连 WebDAV；需 HTTPS 和目标服务允许 CORS。完整包包含项目、素材、提示词、生成历史和媒体；密钥不导出。
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => {
                const ch = createDefaultChannel();
                setConfig({
                  ...config,
                  channels: [...config.channels, ch],
                  activeChannelId: ch.id,
                });
              }}
            >
              添加渠道
            </button>
            <select
              className="field max-w-[200px]"
              value={config.activeChannelId ?? ""}
              onChange={(e) => setConfig({ ...config, activeChannelId: e.target.value })}
            >
              {config.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {error ? <p className="text-[var(--ob-danger)]">{error}</p> : null}
          <p className="text-xs text-[var(--ob-muted)]">
            {import.meta.env.VITE_OPENBOARD_STORAGE === "server"
              ? "API Key 经本地服务加密后存入 PostgreSQL，数据库中不保存明文。"
              : "API Key 仅保存在当前浏览器的本地存储中。"}
            Ark / Seedance 请为对应服务选择 Ark 协议，并填写兼容的
            `/api/v3` Base URL 与模型名。
          </p>
        </div>
      </div>
      <style>{`
        .field { width: 100%; border: 1px solid var(--ob-line); border-radius: 8px; padding: 8px 10px; background: transparent; color: var(--ob-ink); }
        .btn { border: 1px solid var(--ob-line); border-radius: 8px; padding: 8px 12px; background: var(--ob-accent-soft); }
      `}</style>
    </div>
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
