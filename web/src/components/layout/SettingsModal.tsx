import { useCallback, useEffect, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { canManageAdmin } from "@/services/admin";
import {
  DEFAULT_SITE_POLICY,
  getSitePolicy,
  updateSitePolicy,
  type SitePolicy,
} from "@/services/auth-session";
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
import { reconcileProviderModel, resolveSelectableModels } from "@/lib/model-catalog";
import {
  AUDIO_FORMATS,
  DEFAULT_GENERATION_DEFAULTS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  type GenerationDefaults,
} from "@/lib/generation-defaults";
import { createDefaultObjectStorage, normalizeObjectStorage, validateObjectStorageConfig } from "@/lib/object-storage";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { listAllGenerationJobs } from "@/services/generation-jobs";
import { loadPersonalWorkflowTemplates } from "@/services/workflow-templates";
import { ImageToolbarPreferencesEditor } from "@/components/layout/ImageToolbarPreferencesEditor";
import {
  IMAGE_QUALITY_OPTIONS,
  IMAGE_SIZE_OPTIONS,
  optionsWithCurrentValue,
} from "@/lib/image-generation-options";
import { resolveActiveAIChannel, useSharedChannels } from "@/services/shared-channels";
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
  const auth = useOptionalAuth();
  const canManageSitePolicy = canManageAdmin(auth);
  const [sitePolicy, setSitePolicy] = useState<SitePolicy>(DEFAULT_SITE_POLICY);
  const [sitePolicyLoaded, setSitePolicyLoaded] = useState(false);
  const [sitePolicyBusy, setSitePolicyBusy] = useState(false);
	const sharedChannels = useSharedChannels();

  useEffect(() => {
    if (!open) return;
    const active = resolveActiveAIChannel(
      config.channels,
      config.activeChannelId,
      sharedChannels,
      config.activeSharedChannelId,
    );
    if (!active) {
      setModels({});
      return;
    }
    const next: Partial<Record<AiProviderKind, string[]>> = {};
    for (const kind of PROVIDER_KINDS) {
      const cached = getProvider(active, kind).models;
      if (cached?.length) next[kind] = [...cached];
    }
    setModels(next);
  }, [open, config.activeChannelId, config.activeSharedChannelId, config.channels, sharedChannels]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getSitePolicy()
      .then((policy) => {
        if (cancelled) return;
        setSitePolicy(policy);
        setSitePolicyLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSitePolicy(DEFAULT_SITE_POLICY);
        setSitePolicyLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Only the boolean switches are toggleable; model-catalog fields are edited
  // through their own control and must not be flipped by this helper.
  const toggleSitePolicy = async (key: "allowRegister" | "allowCustomChannel" | "allowCloudChannel") => {
    if (!canManageSitePolicy || sitePolicyBusy) return;
    const next = { ...sitePolicy, [key]: !sitePolicy[key] };
    setSitePolicyBusy(true);
    setError(null);
    try {
      const saved = await updateSitePolicy(next);
      setSitePolicy(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "站点策略保存失败");
    } finally {
      setSitePolicyBusy(false);
    }
  };

  const saveModelCatalog = async (patch: Partial<SitePolicy>) => {
    if (!canManageSitePolicy || sitePolicyBusy) return;
    setSitePolicyBusy(true);
    setError(null);
    try {
      setSitePolicy(await updateSitePolicy({ ...sitePolicy, ...patch }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型目录保存失败");
    } finally {
      setSitePolicyBusy(false);
    }
  };

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
  const channel = resolveActiveAIChannel(
    config.channels,
    config.activeChannelId,
    sharedChannels,
    config.activeSharedChannelId,
  ) ?? config.channels[0];
  const sharedChannelSelected = Boolean(config.activeSharedChannelId);

  const updateChannel = (patch: Partial<typeof channel>) => {
    if (sharedChannelSelected) return;
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
      await flushConfig();
      const list = await listModels(channel, kind);
      setModels((current) => ({ ...current, [kind]: list }));
      if (!list.length) {
        setError("未拉取到模型（该服务可能不支持模型列表，请手动填写）");
        return;
      }
      // Now that the channel has told us what it serves, apply the tenant
      // catalog: seed an unset model from the admin default and replace one the
      // channel no longer offers, so the field cannot keep a model that is
      // certain to fail at request time.
      const selectable = resolveSelectableModels(sitePolicy, list);
      const current = getProvider(channel, kind).model;
      const reconciled = reconcileProviderModel(sitePolicy, kind, current, selectable);
      updateProvider(kind, {
        models: list,
        ...(reconciled !== current ? { model: reconciled } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <div className="ob-overlay z-[120] p-2 sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="ob-dialog ob-surface-glass flex w-full max-w-5xl flex-col overflow-hidden shadow-[var(--ob-elev-2)]"
      >
        <header className="flex min-h-16 items-center gap-4 border-b border-[var(--ob-line)] px-4 sm:px-6">
          <div>
            <p className="ob-page-kicker">Workspace</p>
            <h2 id="settings-title" className="text-lg font-semibold tracking-tight">设置</h2>
            <p className="text-xs text-[var(--ob-muted)]">本地工作区配置 · 模型、生成偏好、对象存储与备份</p>
          </div>
          <button
            type="button"
            aria-label="关闭设置"
            title="关闭设置"
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
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              个人渠道仅供当前工作区使用；共享渠道由管理员托管，可在管理后台统一配置。
            </p>
            <div className="grid gap-3 sm:grid-cols-[minmax(180px,0.8fr)_minmax(220px,1.1fr)_minmax(130px,0.5fr)_40px]">
              <Field label="当前渠道">
                <select
                  className="ob-field"
                  aria-label="当前渠道"
                  value={config.activeSharedChannelId ? `shared:${config.activeSharedChannelId}` : `personal:${config.activeChannelId ?? ""}`}
                  onChange={(e) => {
							const [scope, id] = e.target.value.split(":", 2);
							setConfig(scope === "shared" ? { ...config, activeChannelId: null, activeSharedChannelId: id } : { ...config, activeChannelId: id, activeSharedChannelId: null });
						}}
                >
                  {config.channels.map((item) => (
							<option key={item.id} value={`personal:${item.id}`}>{item.name}（个人）</option>
                  ))}
						{sharedChannels.filter((item) => !config.channels.some((personal) => personal.id === item.id)).map((item) => (
							<option key={item.id} value={`shared:${item.id}`}>{item.name}（共享）</option>
						))}
                </select>
              </Field>
              <Field label="渠道名称">
                <input
                  className="ob-field"
                  value={channel.name}
                  disabled={sharedChannelSelected}
                  onChange={(e) => updateChannel({ name: e.target.value })}
                />
              </Field>
              <Field label="请求超时（秒）">
                <input
                  className="ob-field"
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={sharedChannelSelected ? (channel.timeoutSeconds ?? "") : (channel.timeoutSeconds ?? 60)}
                  placeholder={sharedChannelSelected ? "管理员配置" : "60"}
                  disabled={sharedChannelSelected}
                  title={sharedChannelSelected ? "共享渠道超时由管理员在管理后台配置" : "整个请求的最长等待时间"}
                  onChange={(e) => updateChannel({ timeoutSeconds: Number(e.target.value) })}
                />
              </Field>
              <button
                type="button"
                aria-label="添加渠道"
                title={sitePolicy.allowCustomChannel ? "添加渠道" : "管理员已关闭自定义渠道"}
                className="ob-icon-btn mt-5"
                disabled={!sitePolicy.allowCustomChannel}
                onClick={() => {
                  if (!sitePolicy.allowCustomChannel) {
                    setError("管理员已关闭自定义模型渠道");
                    return;
                  }
                  const next = createDefaultChannel();
                  setConfig({
                    ...config,
                    channels: [...config.channels, next],
                    activeChannelId: next.id,
									activeSharedChannelId: null,
                  });
                }}
              >
                <Plus size={17} />
              </button>
            </div>
          </section>

          <section className="mb-6">
            <SectionTitle title="模型服务" />
            <div className="overflow-hidden rounded-xl border border-[var(--ob-line)] shadow-[var(--ob-elev-1)]">
              <div className="hidden grid-cols-[110px_140px_minmax(180px,1.3fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_44px] gap-2 border-b border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_80%,var(--ob-panel))] px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ob-muted)] md:grid">
                <span>能力</span><span>协议</span><span>服务 URL</span><span>API Key</span><span>模型</span><span />
              </div>
              {PROVIDER_KINDS.map((kind) => (
                <ProviderRow
                  key={kind}
                  kind={kind}
                  provider={getProvider(channel, kind)}
                  models={resolveSelectableModels(sitePolicy, models[kind] ?? getProvider(channel, kind).models ?? [])}
                  busy={busyKind === kind}
                  disabled={busyKind !== null || sharedChannelSelected}
                  onPull={() => void pullModels(kind)}
                  onChange={(patch) => updateProvider(kind, patch)}
                />
              ))}
            </div>
          </section>

          <section className="mb-6 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
            <div>
              <SectionTitle title="生成偏好" />
              {canManageSitePolicy ? (
                <>
                  <Field label="全局系统提示词">
                    <textarea
                      className="ob-field min-h-28 resize-y"
                      maxLength={SYSTEM_PROMPT_MAX_LENGTH}
                      value={config.systemPrompt}
                      onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
                      placeholder="应用于文本、图片生成和图片编辑请求"
                    />
                  </Field>
                  <Field label="工作流 Agent 系统提示词">
                    <textarea
                      className="ob-field min-h-24 resize-y"
                      maxLength={SYSTEM_PROMPT_MAX_LENGTH}
                      value={config.workflowAgentSystemPrompt ?? ""}
                      onChange={(e) => setConfig({ ...config, workflowAgentSystemPrompt: e.target.value })}
                      placeholder="留空则使用内置默认提示词"
                    />
                  </Field>
                  <p className="mb-3 text-xs text-[var(--ob-muted)]">
                    系统提示词为租户级配置，仅管理员可修改；成员侧保存不会改写服务端生成使用的提示词。
                  </p>
                </>
              ) : (
                <div className="mb-3 rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_70%,transparent)] px-3 py-3 text-xs text-[var(--ob-muted)]">
                  <p className="font-medium text-[var(--ob-ink)]">系统提示词由管理员维护</p>
                  <p className="mt-1">
                    当前账号为普通成员，租户级系统提示词只读生效于服务端生成；如需调整请联系管理员。
                  </p>
                  {config.systemPrompt.trim() ? (
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[var(--ob-ink)]/80" title={config.systemPrompt}>
                      当前生效摘要：{config.systemPrompt.trim()}
                    </p>
                  ) : (
                    <p className="mt-2">当前未配置全局系统提示词。</p>
                  )}
                </div>
              )}
            </div>
            <div className="grid content-start grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-8 lg:grid-cols-1">
              <Field label="图片尺寸">
                <select className="ob-field" value={config.imageSize} onChange={(e) => setConfig({ ...config, imageSize: e.target.value })}>
                  {optionsWithCurrentValue(IMAGE_SIZE_OPTIONS, config.imageSize).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="图片质量">
                <select className="ob-field" value={config.imageQuality} onChange={(e) => setConfig({ ...config, imageQuality: e.target.value })}>
                  {optionsWithCurrentValue(IMAGE_QUALITY_OPTIONS, config.imageQuality).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="默认数量">
                <input className="ob-field" type="number" min={1} max={8} value={config.imageCount} onChange={(e) => setConfig({ ...config, imageCount: Number(e.target.value) || 1 })} />
              </Field>
              <p className="text-xs text-[var(--ob-muted)] sm:col-span-3 lg:col-span-1">
                尺寸与质量会原样发送给模型服务；部分模型可能不支持全部预设。
              </p>
            </div>
          </section>


          <section className="mb-6">
            <SectionTitle title="生成默认值" />
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              新建的视频与音频节点会继承这些值；节点上已显式设置的值不会被覆盖。
            </p>
            <GenerationDefaultsEditor
              value={config.generationDefaults ?? DEFAULT_GENERATION_DEFAULTS}
              onChange={(generationDefaults) => setConfig({ ...config, generationDefaults })}
            />
          </section>

          {canManageSitePolicy ? (
            <section className="mb-6">
              <SectionTitle title="站点策略" />
              <p className="mb-3 text-xs text-[var(--ob-muted)]">
                管理员控制开放注册、用户自定义渠道与云端/后端代理生成。更改立即对当前租户生效。
              </p>
              {!sitePolicyLoaded ? (
                <p className="text-xs text-[var(--ob-muted)]">正在加载站点策略…</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sitePolicy.allowRegister}
                      aria-label="允许开放注册"
                      className="ob-switch"
                      data-checked={sitePolicy.allowRegister ? "true" : "false"}
                      disabled={sitePolicyBusy}
                      onClick={() => void toggleSitePolicy("allowRegister")}
                    />
                    <span className="text-sm text-[var(--ob-ink)]">允许开放注册</span>
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sitePolicy.allowCustomChannel}
                      aria-label="允许自定义渠道"
                      className="ob-switch"
                      data-checked={sitePolicy.allowCustomChannel ? "true" : "false"}
                      disabled={sitePolicyBusy}
                      onClick={() => void toggleSitePolicy("allowCustomChannel")}
                    />
                    <span className="text-sm text-[var(--ob-ink)]">允许自定义渠道</span>
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sitePolicy.allowCloudChannel}
                      aria-label="允许云端渠道生成"
                      className="ob-switch"
                      data-checked={sitePolicy.allowCloudChannel ? "true" : "false"}
                      disabled={sitePolicyBusy}
                      onClick={() => void toggleSitePolicy("allowCloudChannel")}
                    />
                    <span className="text-sm text-[var(--ob-ink)]">允许云端渠道生成</span>
                  </label>
                </div>
              )}
              {!sitePolicy.allowCustomChannel ? (
                <p className="mt-2 text-xs text-[var(--ob-muted)]">当前禁止新增自定义模型渠道；已有渠道仍可编辑与使用。</p>
              ) : null}
              {!sitePolicy.allowCloudChannel ? (
                <p className="mt-2 text-xs text-[var(--ob-muted)]">后端代理/云端生成已关闭；客户端直连渠道不受此开关影响。</p>
              ) : null}
              {sitePolicyLoaded ? (
                <ModelCatalogEditor
                  policy={sitePolicy}
                  busy={sitePolicyBusy}
                  onSave={(patch) => void saveModelCatalog(patch)}
                />
              ) : null}
            </section>
          ) : null}

          <section className="mb-6">
            <SectionTitle title="图片节点快捷工具" />
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              调整图片节点悬浮工具的显示和顺序；下载操作始终保留。
            </p>
            <ImageToolbarPreferencesEditor
              value={config.imageToolbar}
              onChange={(imageToolbar) => setConfig({ ...config, imageToolbar })}
            />
          </section>

          <section className="mb-6">
            <SectionTitle title="对象存储 (S3/R2)" />
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              登录后可随账号同步。开启后正式模式下该账号的媒体写入优先使用此配置；密钥经本地服务加密存储，不会导出到 WebDAV 备份。
            </p>
            <div className="mb-3 flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(config.objectStorage?.enabled)}
                className="ob-switch"
                data-checked={config.objectStorage?.enabled ? "true" : "false"}
                onClick={() => {
                  const current = normalizeObjectStorage(config.objectStorage);
                  setConfig({ ...config, objectStorage: { ...current, enabled: !current.enabled } });
                }}
              />
              <span className="text-sm text-[var(--ob-muted)]">启用用户级 S3/R2</span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Field label="Endpoint">
                <input
                  className="ob-field"
                  value={config.objectStorage?.endpoint ?? ""}
                  placeholder="https://&lt;account&gt;.r2.cloudflarestorage.com"
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), endpoint: e.target.value },
                  })}
                />
              </Field>
              <Field label="Bucket">
                <input
                  className="ob-field"
                  value={config.objectStorage?.bucket ?? ""}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), bucket: e.target.value },
                  })}
                />
              </Field>
              <Field label="Region">
                <input
                  className="ob-field"
                  value={config.objectStorage?.region ?? "auto"}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), region: e.target.value },
                  })}
                />
              </Field>
              <Field label="Prefix">
                <input
                  className="ob-field"
                  value={config.objectStorage?.prefix ?? "openboard"}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), prefix: e.target.value },
                  })}
                />
              </Field>
              <Field label="Access Key ID">
                <input
                  className="ob-field"
                  value={config.objectStorage?.accessKeyId ?? ""}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), accessKeyId: e.target.value },
                  })}
                />
              </Field>
              <Field label="Secret Access Key">
                <input
                  className="ob-field"
                  type="password"
                  value={config.objectStorage?.secretAccessKey ?? ""}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), secretAccessKey: e.target.value },
                  })}
                />
              </Field>
              <Field label="Session Token (可选)">
                <input
                  className="ob-field"
                  type="password"
                  value={config.objectStorage?.sessionToken ?? ""}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), sessionToken: e.target.value },
                  })}
                />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--ob-muted)]">
                <input
                  type="checkbox"
                  checked={Boolean(config.objectStorage?.allowInsecureLoopback)}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), allowInsecureLoopback: e.target.checked },
                  })}
                />
                允许 loopback HTTP (MinIO)
              </label>
            </div>
            {(() => {
              const validation = validateObjectStorageConfig(normalizeObjectStorage(config.objectStorage));
              return validation ? <p className="mt-2 text-xs text-[var(--ob-danger)]">{validation}</p> : null;
            })()}
          </section>
          <section>
            <SectionTitle title="WebDAV 备份" />
            <div className="grid gap-3 lg:grid-cols-[1.4fr_0.7fr_0.7fr]">
              <Field label="WebDAV URL">
                <input className="ob-field" value={config.webdavUrl ?? ""} onChange={(e) => setConfig({ ...config, webdavUrl: e.target.value })} placeholder="https://example.com/dav/openboard" />
              </Field>
              <Field label="用户名">
                <input className="ob-field" value={config.webdavUser ?? ""} onChange={(e) => setConfig({ ...config, webdavUser: e.target.value })} />
              </Field>
              <Field label="密码">
                <input className="ob-field" type="password" value={config.webdavPass ?? ""} onChange={(e) => setConfig({ ...config, webdavPass: e.target.value })} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="ob-btn"
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
                  className="ob-btn"
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
                          workflowTemplates: await loadPersonalWorkflowTemplates(),
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
                  className="ob-btn"
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
                  className="ob-btn"
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
              ? "API Key 与对象存储密钥经本地服务加密后存入 PostgreSQL，数据库中不保存明文。"
              : "API Key 仅保存在当前浏览器的本地存储中。"}
            Ark / Seedance 请为对应服务选择 Ark 协议，并填写兼容的
            `/api/v3` Base URL 与模型名。
            </p>
          </div>
        </div>
      </div>
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
          <select className="ob-field" aria-label={`${label}协议`} value={provider.protocol} disabled={disabled} onChange={(e) => onChange({ protocol: e.target.value as typeof provider.protocol })}>
            <option value="openai">OpenAI</option>
            <option value="ark">Ark / Seedance</option>
            <option value="gemini">Gemini</option>
            <option value="apimart">APIMart（仅服务端）</option>
            <option value="kie">KIE Market（仅服务端）</option>
            <option value="template">Template</option>
          </select>
        </CompactField>
        <CompactField label="服务 URL">
          <input className="ob-field" aria-label={`${label} URL`} value={provider.baseUrl} disabled={disabled} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="服务 URL" />
        </CompactField>
        <CompactField label="API Key">
          <input className="ob-field" aria-label={`${label} API Key`} type="password" value={provider.apiKey} disabled={disabled} onChange={(e) => onChange({ apiKey: e.target.value })} placeholder="API Key" />
        </CompactField>
        <CompactField label="模型">
          <input className="ob-field" aria-label={`${label}模型`} value={provider.model} disabled={disabled} onChange={(e) => onChange({ model: e.target.value })} placeholder="模型名称" />
        </CompactField>
        <button type="button" className="ob-icon-btn disabled:opacity-50" aria-label={`拉取${label}模型`} title={`拉取${label}模型`} disabled={disabled} onClick={onPull}>
          <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
        </button>
      </div>
      {provider.protocol === "template" ? <TemplateEditor value={provider.template} onChange={(template) => onChange({ template })} /> : null}
      {models.length ? (
        <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-auto pl-0 md:pl-[250px]">
          {models.map((model) => (
            <button
              key={model}
              type="button"
              disabled={disabled}
              className="ob-chip cursor-pointer transition-colors hover:border-[var(--ob-accent)] hover:text-[var(--ob-accent)]"
              onClick={() => onChange({ model })}
            >
              {model}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ob-muted)]">
      <span className="h-px w-3 bg-[color-mix(in_srgb,var(--ob-accent)_55%,transparent)]" aria-hidden />
      {title}
    </h3>
  );
}

/**
 * Tenant model governance. The allow list narrows what ordinary users may pick;
 * leaving it empty means "no restriction" so a misconfiguration cannot strand
 * users with zero models. Defaults must name a model inside a non-empty list,
 * which the server enforces independently.
 */
function ModelCatalogEditor({
  policy,
  busy,
  onSave,
}: {
  policy: SitePolicy;
  busy: boolean;
  onSave: (patch: Partial<SitePolicy>) => void;
}) {
  const [draft, setDraft] = useState(() => (policy.availableModels ?? []).join("\n"));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft((policy.availableModels ?? []).join("\n"));
  }, [policy.availableModels, dirty]);

  const defaults: Array<{ key: keyof SitePolicy; label: string }> = [
    { key: "defaultTextModel", label: "默认文本模型" },
    { key: "defaultImageModel", label: "默认图片模型" },
    { key: "defaultVideoModel", label: "默认视频模型" },
    { key: "defaultAudioModel", label: "默认音频模型" },
  ];
  const allowList = (policy.availableModels ?? []);
  // The select must be able to display whatever is currently stored. An empty
  // allow list means "no restriction", and a default configured before the
  // list was narrowed is still the effective value, so both cases need an
  // option or the control would silently read back as "未设置".
  const optionsFor = (current: string): string[] =>
    current && !allowList.includes(current) ? [...allowList, current] : allowList;

  return (
    <div className="mt-4 rounded-xl border border-[var(--ob-line)] p-3">
      <p className="mb-2 text-xs text-[var(--ob-muted)]">
        可用模型白名单（每行一个）。留空表示不限制，前台仍按已启用渠道的模型展示。
      </p>
      <textarea
        aria-label="可用模型白名单"
        className="ob-field min-h-20 w-full resize-y font-mono text-xs"
        placeholder="gpt-image-2&#10;gpt-5.5"
        value={draft}
        disabled={busy}
        onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
      />
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {defaults.map(({ key, label }) => (
          <label key={key} className="grid gap-1">
            <span className="text-xs text-[var(--ob-muted)]">{label}</span>
            <select
              className="ob-field"
              aria-label={label}
              value={(policy[key] as string | undefined) ?? ""}
              disabled={busy}
              onChange={(event) => onSave({ [key]: event.target.value } as Partial<SitePolicy>)}
            >
              <option value="">未设置（按类型自动选择）</option>
              {optionsFor((policy[key] as string | undefined) ?? "")
                .map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
        ))}
      </div>
      <button
        type="button"
        className="ob-btn mt-2"
        disabled={busy || !dirty}
        onClick={() => {
          const availableModels = [...new Set(
            draft.split("\n").map((line) => line.trim()).filter(Boolean),
          )];
          setDirty(false);
          onSave({ availableModels });
        }}
      >
        保存模型白名单
      </button>
    </div>
  );
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
        className="ob-field min-h-40 resize-y font-mono text-xs"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className="ob-btn"
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

/**
 * Editor for the tenant generation defaults new video and audio nodes inherit.
 * Each control writes the whole normalized object so a partial value can never
 * be persisted, and the input is never mutated in place.
 */
function GenerationDefaultsEditor({
  value,
  onChange,
}: {
  value: GenerationDefaults;
  onChange: (next: GenerationDefaults) => void;
}) {
  const update = (patch: Partial<GenerationDefaults>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="默认视频比例">
        <select
          className="ob-field"
          aria-label="默认视频比例"
          value={value.videoRatio}
          onChange={(event) => update({ videoRatio: event.target.value })}
        >
          {VIDEO_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
      </Field>
      <Field label="默认清晰度">
        <select
          className="ob-field"
          aria-label="默认清晰度"
          value={value.videoResolution}
          onChange={(event) => update({ videoResolution: event.target.value })}
        >
          {VIDEO_RESOLUTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </Field>
      <Field label="默认时长（秒）">
        <input
          className="ob-field"
          aria-label="默认时长（秒）"
          type="number"
          min={4}
          max={15}
          value={value.videoSeconds}
          onChange={(event) => update({
            videoSeconds: Math.min(15, Math.max(4, Math.round(Number(event.target.value)) ||
              DEFAULT_GENERATION_DEFAULTS.videoSeconds)),
          })}
        />
      </Field>
      <Field label="默认音频格式">
        <select
          className="ob-field"
          aria-label="默认音频格式"
          value={value.audioFormat}
          onChange={(event) => update({ audioFormat: event.target.value })}
        >
          {AUDIO_FORMATS.map((format) => <option key={format} value={format}>{format}</option>)}
        </select>
      </Field>
      <Field label="默认声音">
        <input
          className="ob-field"
          aria-label="默认声音"
          maxLength={64}
          value={value.audioVoice}
          onChange={(event) => update({ audioVoice: event.target.value })}
          placeholder={DEFAULT_GENERATION_DEFAULTS.audioVoice}
        />
      </Field>
      <Field label="默认语速">
        <input
          className="ob-field"
          aria-label="默认语速"
          type="number"
          min={0}
          max={4}
          step={0.05}
          value={value.audioSpeed}
          onChange={(event) => {
            // 0 means "unset" so the provider default applies; anything else is
            // clamped into the range the provider accepts.
            const parsed = Number(event.target.value);
            const speed = !Number.isFinite(parsed) || parsed <= 0
              ? 0
              : Math.min(4, Math.max(0.25, parsed));
            update({ audioSpeed: speed });
          }}
          placeholder="0 表示使用服务商默认"
        />
      </Field>
      <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
        <button
          type="button"
          role="switch"
          aria-checked={value.videoGenerateAudio}
          aria-label="默认生成声音"
          className="ob-switch"
          data-checked={value.videoGenerateAudio ? "true" : "false"}
          onClick={() => update({ videoGenerateAudio: !value.videoGenerateAudio })}
        />
        <span className="text-sm text-[var(--ob-ink)]">默认生成声音</span>
      </label>
      <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
        <button
          type="button"
          role="switch"
          aria-checked={value.videoWatermark}
          aria-label="默认添加水印"
          className="ob-switch"
          data-checked={value.videoWatermark ? "true" : "false"}
          onClick={() => update({ videoWatermark: !value.videoWatermark })}
        />
        <span className="text-sm text-[var(--ob-ink)]">默认添加水印</span>
      </label>
      <Field label="默认语音指令">
        <input
          className="ob-field"
          aria-label="默认语音指令"
          maxLength={2_000}
          value={value.audioInstructions}
          onChange={(event) => update({ audioInstructions: event.target.value })}
          placeholder="留空则不发送"
        />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="ob-label !mb-0">{label}</span>
      {children}
    </label>
  );
}
