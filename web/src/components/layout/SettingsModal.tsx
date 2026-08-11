import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { canManageAdmin } from "@/services/admin";
import {
  DEFAULT_SITE_POLICY,
  getSitePolicy,
  updateSitePolicy,
  type SitePolicy,
  type UsageSnapshot,
} from "@/services/auth-session";
import { createDefaultChannel } from "@/lib/defaults";
import { listModels } from "@/services/ai-client";
import { webdavGetBlob, webdavPutBlob } from "@/services/webdav";
import { exportCompleteProjectBundle, exportCompleteWorkspaceBundle, importCompleteProjectBundle, importCompleteWorkspaceBundle } from "@/services/film-bundle";
import { getProvider, normalizeChannel } from "@/lib/ai-config";
import type { AiProviderKind } from "@/types/board";
import type { AiTemplateConfig } from "@/types/board";
import { validateProviderTemplate } from "@/lib/provider-template";
import { SYSTEM_PROMPT_MAX_LENGTH } from "@/lib/app-config";
import { reconcileProviderModel, resolveSelectableModels } from "@/lib/model-catalog";
import {
  DEFAULT_GENERATION_DEFAULTS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  type GenerationDefaults,
} from "@/lib/generation-defaults";
import { createDefaultObjectStorage, normalizeObjectStorage, validateObjectStorageConfig } from "@/lib/object-storage";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";
import { listAllGenerationJobs } from "@/services/generation-jobs";
import { loadPersonalWorkflowTemplates } from "@/services/workflow-templates";
import { ImageToolbarPreferencesEditor } from "@/components/layout/ImageToolbarPreferencesEditor";
import {
  imageQualityOptionsFor,
  normalizeImageQualityForProvider,
  normalizeImageSizeForProvider,
  imageSizeOptionsFor,
  optionsWithCurrentValue,
} from "@/lib/image-generation-options";
import {
  exportConfigFile,
  hasSameChannelConfiguration,
  importConfigFile,
} from "@/lib/config-file";
import { resolveActiveAIChannel, useSharedChannels } from "@/services/shared-channels";
import {
  AUDIO_PROTOCOL_OPTIONS,
  audioFormatOptions,
  audioVoiceLabel,
  audioProtocolRequiresKey,
  audioProviderPreset,
  audioVoiceOptions,
  defaultAudioVoice,
} from "@/lib/audio-provider";
import {
  AudioLines,
  CloudDownload,
  CloudUpload,
  Database,
  Film,
  FolderCog,
  HardDrive,
  Image as ImageIcon,
  Languages,

  MousePointerClick,
  Palette,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Sliders,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";

const PROVIDER_KINDS: AiProviderKind[] = ["text", "image", "video", "audio"];
const PROVIDER_LABEL_KEYS: Record<AiProviderKind, MessageKey> = {
  text: "common.text",
  image: "common.image",
  video: "common.video",
  audio: "common.audio",
};

export type SettingsSectionDefinition = Readonly<{
  id: string;
  labelKey: MessageKey;
  icon: LucideIcon;
}>;

const MEMBER_SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = Object.freeze([
  { id: "interface", labelKey: "settings.interface", icon: Languages },
  { id: "channel", labelKey: "settings.channel", icon: Radio },
  { id: "usage", labelKey: "settings.usage", icon: Database },
  { id: "model", labelKey: "settings.modelServices", icon: Server },
  { id: "generation", labelKey: "settings.generationPreferences", icon: Palette },
  { id: "defaults", labelKey: "settings.generationDefaults", icon: Sliders },
  { id: "toolbar", labelKey: "settings.imageTools", icon: MousePointerClick },
  { id: "storage", labelKey: "settings.objectStorage", icon: HardDrive },
  { id: "configfile", labelKey: "settings.configFile", icon: FolderCog },
  { id: "webdav", labelKey: "settings.webdavTitle", icon: Database },
]);

const SITE_POLICY_SECTION: SettingsSectionDefinition = Object.freeze({
  id: "policy",
  labelKey: "settings.sitePolicy",
  icon: ShieldCheck,
});

export function settingsSectionsFor(canManageSitePolicy: boolean): readonly SettingsSectionDefinition[] {
  if (!canManageSitePolicy) return [...MEMBER_SETTINGS_SECTIONS];
  return [
    ...MEMBER_SETTINGS_SECTIONS.slice(0, 6),
    SITE_POLICY_SECTION,
    ...MEMBER_SETTINGS_SECTIONS.slice(6),
  ];
}

function formatUsageBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.round(safe)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safe / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${Number(value.toFixed(1))} ${unit}`;
}

export function UsageOverview({ snapshot, onRefresh }: { snapshot: UsageSnapshot | null; onRefresh: () => void }) {
  const { t } = useI18n();
  if (!snapshot) {
    return <div className="rounded-xl border border-[var(--ob-line)] p-4"><p className="text-sm text-[var(--ob-muted)]">{t("settings.usageUnavailable")}</p><button type="button" className="ob-btn mt-3" onClick={onRefresh}><RefreshCw size={14} /> {t("settings.retry")}</button></div>;
  }
  const cards = [
    { label: t("settings.teamQuota"), value: `${snapshot.generationThisMonth} / ${snapshot.generationQuotaMonthly}`, note: t("settings.teamQuotaNote") },
    { label: t("settings.personalCredits"), value: String(snapshot.credits ?? 0), note: t("settings.personalCreditsNote") },
    { label: t("settings.serverStorage"), value: `${formatUsageBytes(snapshot.storageBytes)} / ${formatUsageBytes(snapshot.storageQuotaBytes)}`, note: t("settings.serverStorageNote") },
  ];
  return <div><div className="grid gap-3 md:grid-cols-3">{cards.map((card) => <div key={card.label} className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-3"><p className="text-xs text-[var(--ob-muted)]">{card.label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{card.value}</p><p className="mt-1 text-xs text-[var(--ob-muted)]">{card.note}</p></div>)}</div><div className="mt-3 flex flex-wrap items-center gap-2"><span className="ob-chip">{t("settings.plan", { plan: snapshot.plan || "free" })}</span><button type="button" className="ob-btn" onClick={onRefresh}><RefreshCw size={14} /> {t("settings.refreshUsage")}</button></div><p className="mt-2 text-xs text-[var(--ob-muted)]">{t("settings.usageExplanation")}</p></div>;
}

export function settingsScrollTarget(
  scrollTop: number,
  containerTop: number,
  sectionTop: number,
): number {
  return Math.max(0, scrollTop + sectionTop - containerTop - 16);
}

export function settingsHorizontalScrollTarget(
  scrollLeft: number,
  containerLeft: number,
  containerWidth: number,
  itemLeft: number,
  itemWidth: number,
  maxScrollLeft: number,
): number {
  const centered = scrollLeft + itemLeft - containerLeft - ((containerWidth - itemWidth) / 2);
  return Math.min(maxScrollLeft, Math.max(0, centered));
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { locale, setLocale, t } = useI18n();
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
  const settingsSections = useMemo(
    () => settingsSectionsFor(canManageSitePolicy),
    [canManageSitePolicy],
  );
  const [activeSection, setActiveSection] = useState("interface");
  const scrollRef = useRef<HTMLDivElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);

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

  useEffect(() => {
    if (!open) return;
    setActiveSection((current) => (
      settingsSections.some((section) => section.id === current)
        ? current
        : "channel"
    ));
  }, [open, settingsSections]);

  useEffect(() => {
    if (!open) return;
    const navigation = mobileNavigationRef.current;
    const activeButton = navigation?.querySelector<HTMLElement>(
      `[data-section-nav-id="${activeSection}"]`,
    );
    if (!navigation || !activeButton) return;
    const frame = window.requestAnimationFrame(() => {
      const navigationRect = navigation.getBoundingClientRect();
      const activeRect = activeButton.getBoundingClientRect();
      const maxScrollLeft = Math.max(0, navigation.scrollWidth - navigation.clientWidth);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      navigation.scrollTo({
        left: settingsHorizontalScrollTarget(
          navigation.scrollLeft,
          navigationRect.left,
          navigationRect.width,
          activeRect.left,
          activeRect.width,
          maxScrollLeft,
        ),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, open]);

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
      setError(cause instanceof Error ? cause.message : t("settings.sitePolicySaveFailed"));
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
      setError(cause instanceof Error ? cause.message : t("settings.modelCatalogSaveFailed"));
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
        setError(cause instanceof Error ? cause.message : t("settings.configSaveFailed"));
      });
  }, [closing, flushConfig, onClose, t]);
  useEscapeDismiss(open, requestClose);

  const scrollToSection = (id: string) => {
    const container = scrollRef.current;
    const section = container?.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
    if (!container || !section) return;
    setActiveSection(id);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({
      top: settingsScrollTarget(
        container.scrollTop,
        container.getBoundingClientRect().top,
        section.getBoundingClientRect().top,
      ),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
      const lastSection = settingsSections.at(-1)?.id ?? "channel";
      setActiveSection((current) => current === lastSection ? current : lastSection);
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    let closest = settingsSections[0]?.id ?? "channel";
    let minDistance = Number.POSITIVE_INFINITY;
    for (const section of container.querySelectorAll<HTMLElement>("[data-section-id]")) {
      const distance = Math.abs(section.getBoundingClientRect().top - containerTop - 16);
      if (distance < minDistance && section.dataset.sectionId) {
        minDistance = distance;
        closest = section.dataset.sectionId;
      }
    }
    setActiveSection((current) => current === closest ? current : closest);
  };

  if (!open) return null;
  const channel = resolveActiveAIChannel(
    config.channels,
    config.activeChannelId,
    sharedChannels,
    config.activeSharedChannelId,
  ) ?? config.channels[0];
  const imageProvider = channel ? getProvider(channel, "image") : undefined;
  const imageQualityOptions = imageQualityOptionsFor(imageProvider?.protocol, imageProvider?.model);
  const imageQuality = normalizeImageQualityForProvider(
    config.imageQuality,
    imageProvider?.protocol,
    imageProvider?.model,
  );
  const imageSizeOptions = imageSizeOptionsFor(imageProvider?.protocol, imageProvider?.model);
  const imageSize = normalizeImageSizeForProvider(config.imageSize);
  const sharedChannelSelected = Boolean(config.activeSharedChannelId);
	const selectedSharedChannelAvailable = !sharedChannelSelected || sharedChannels.some((item) => item.id === config.activeSharedChannelId);
  const personalChannelEditable = canManageSitePolicy || (
    sitePolicyLoaded && sitePolicy.allowCustomChannel
  );

  const updateChannel = (patch: Partial<typeof channel>) => {
    if (sharedChannelSelected || !personalChannelEditable) return;
    setConfig({
      ...config,
      channels: config.channels.map((c) =>
        c.id === channel.id ? { ...c, ...patch } : c,
      ),
    });
  };

  const updateProvider = (kind: AiProviderKind, patch: Partial<ReturnType<typeof getProvider>>) => {
    if (!personalChannelEditable) return;
    const normalized = normalizeChannel(channel);
    const providers = { ...normalized.providers!, [kind]: { ...normalized.providers![kind], ...patch } };
    const nextProtocol = kind === "audio" ? providers.audio.protocol : undefined;
    const generationDefaults = nextProtocol && patch.protocol
      ? {
          ...(config.generationDefaults ?? DEFAULT_GENERATION_DEFAULTS),
          audioVoice: defaultAudioVoice(nextProtocol),
          audioFormat: audioFormatOptions(nextProtocol)[0] ?? "mp3",
        }
      : config.generationDefaults;
    setConfig({
      ...config,
      channels: config.channels.map((item) => item.id === channel.id ? { ...item, providers } : item),
      generationDefaults,
    });
  };

  const pullModels = async (kind: AiProviderKind) => {
    setBusyKind(kind);
    setError(null);
    try {
      await flushConfig();
      const list = await listModels(channel, kind);
      setModels((current) => ({ ...current, [kind]: list }));
      if (!list.length) {
        setError(t("settings.modelsNotFound"));
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
            <p className="ob-page-kicker">{t("settings.kicker")}</p>
            <h2 id="settings-title" className="text-lg font-semibold tracking-tight">{t("settings.title")}</h2>
            <p className="text-xs text-[var(--ob-muted)]">{t("settings.subtitle")}</p>
          </div>
          <button
            type="button"
            aria-label={t("settings.close")}
            title={t("settings.close")}
            className="ob-icon-btn ml-auto"
            disabled={closing}
            onClick={requestClose}
          >
            {closing ? <RefreshCw className="animate-spin" size={17} /> : <X size={18} />}
          </button>
        </header>

        {/* Mobile horizontal section navigation */}
        <nav ref={mobileNavigationRef} className="ob-settings-tabbar" aria-label={t("settings.sections")}>
          {settingsSections.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                className="ob-settings-tabbar-item"
                data-active={activeSection === s.id}
                data-section-nav-id={s.id}
                aria-current={activeSection === s.id ? "location" : undefined}
                onClick={() => scrollToSection(s.id)}
              >
                <Icon size={13} />
                {t(s.labelKey)}
              </button>
            );
          })}
        </nav>

        <div className="flex min-h-0 flex-1">
          {/* Desktop sidebar navigation */}
          <nav className="ob-settings-sidebar" aria-label={t("settings.sections")}>
            {settingsSections.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="ob-settings-sidebar-link"
                  data-active={activeSection === s.id}
                  aria-current={activeSection === s.id ? "location" : undefined}
                  onClick={() => scrollToSection(s.id)}
                >
                  <Icon size={14} />
                  {t(s.labelKey)}
                </button>
              );
            })}
          </nav>

          {/* Scrollable content */}
          <div
            ref={scrollRef}
            data-settings-scroll-container
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-5 text-sm sm:px-6"
          >
          <section className="ob-settings-section mb-5" data-section-id="interface">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><Languages size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.interface")}</div>
                <div className="ob-settings-section-desc">{t("settings.interfaceDescription")}</div>
              </div>
            </div>
            <Field label={t("settings.language")}>
              <select
                className="ob-field max-w-xs"
                aria-label={t("settings.language")}
                value={locale}
                onChange={(event) => setLocale(event.target.value === "en-US" ? "en-US" : "zh-CN")}
              >
                <option value="zh-CN">{t("locale.zhCN")}</option>
                <option value="en-US">{t("locale.enUS")}</option>
              </select>
            </Field>
            <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("settings.languageDescription")}</p>
          </section>

          <section className="ob-settings-section mb-5" data-section-id="channel">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><Radio size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.channel")}</div>
                <div className="ob-settings-section-desc">{t("settings.channelDescription")}</div>
              </div>
            </div>
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              {t("settings.channelHint")}
            </p>
            <div className="grid gap-3 sm:grid-cols-[minmax(180px,0.8fr)_minmax(220px,1.1fr)_minmax(130px,0.5fr)_40px]">
              <Field label={t("settings.currentChannel")}>
                <select
                  className="ob-field"
                  aria-label={t("settings.currentChannel")}
                  value={config.activeSharedChannelId ? `shared:${config.activeSharedChannelId}` : `personal:${config.activeChannelId ?? ""}`}
                  onChange={(e) => {
							const [scope, id] = e.target.value.split(":", 2);
							setConfig(scope === "shared" ? { ...config, activeChannelId: null, activeSharedChannelId: id } : { ...config, activeChannelId: id, activeSharedChannelId: null });
						}}
                >
					{sharedChannelSelected && !selectedSharedChannelAvailable ? (
						<option value={`shared:${config.activeSharedChannelId}`}>{t("settings.sharedUnavailable")}</option>
					) : null}
                  {config.channels.map((item) => (
							<option key={item.id} value={`personal:${item.id}`}>{item.name} {t("settings.personalSuffix")}</option>
                  ))}
						{sharedChannels.filter((item) => !config.channels.some((personal) => personal.id === item.id)).map((item) => (
							<option key={item.id} value={`shared:${item.id}`}>{item.name} {t("settings.sharedSuffix")}</option>
						))}
                </select>
              </Field>
              <Field label={t("settings.channelName")}>
                <input
                  className="ob-field"
                  value={channel.name}
                  disabled={sharedChannelSelected || !personalChannelEditable}
                  title={!personalChannelEditable ? t("settings.memberChannelLocked") : undefined}
                  onChange={(e) => updateChannel({ name: e.target.value })}
                />
              </Field>
              <Field label={t("settings.timeout")}>
                <input
                  className="ob-field"
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={sharedChannelSelected ? (channel.timeoutSeconds ?? "") : (channel.timeoutSeconds ?? 60)}
                  placeholder={sharedChannelSelected ? t("settings.adminConfigured") : "60"}
                  disabled={sharedChannelSelected || !personalChannelEditable}
                  title={sharedChannelSelected
                    ? t("settings.sharedTimeoutHint")
                    : !personalChannelEditable
                      ? t("settings.memberChannelLocked")
                      : t("settings.timeoutHint")}
                  onChange={(e) => updateChannel({ timeoutSeconds: Number(e.target.value) })}
                />
              </Field>
              <button
                type="button"
                aria-label={t("settings.addChannel")}
                title={personalChannelEditable ? t("settings.addChannel") : t("settings.customChannelsDisabled")}
                className="ob-icon-btn mt-5"
                disabled={!personalChannelEditable}
                onClick={() => {
                  if (!personalChannelEditable) {
                    setError(t("settings.customChannelDisabledError"));
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

          <section className="ob-settings-section mb-5" data-section-id="usage">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><Database size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.usageTitle")}</div>
                <div className="ob-settings-section-desc">{t("settings.usageDescription")}</div>
              </div>
            </div>
            <UsageOverview snapshot={auth?.usageSnapshot ?? null} onRefresh={() => { void auth?.refreshUsage(); }} />
          </section>

          <section className="ob-settings-section mb-5" data-section-id="model">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><Server size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.modelServices")}</div>
                <div className="ob-settings-section-desc">{t("settings.modelServicesDescription")}</div>
              </div>
            </div>
            {sharedChannelSelected ? (
              <SharedChannelManagedNotice channelName={selectedSharedChannelAvailable ? channel.name : t("settings.sharedUnavailable")} />
            ) : <>
              {!personalChannelEditable ? (
                <p className="mb-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-accent-soft)] px-3 py-2 text-xs text-[var(--ob-muted)]">
                  {t("settings.memberChannelsDisabled")}
                </p>
              ) : null}
              <div className="overflow-hidden rounded-xl border border-[var(--ob-line)] shadow-[var(--ob-elev-1)]">
              <div className="hidden grid-cols-[110px_140px_minmax(180px,1.3fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_44px] gap-2 border-b border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_80%,var(--ob-panel))] px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ob-muted)] md:grid">
                <span>{t("settings.capability")}</span><span>{t("settings.protocol")}</span><span>{t("settings.serviceUrl")}</span><span>API Key</span><span>{t("settings.model")}</span><span />
              </div>
              {PROVIDER_KINDS.map((kind) => (
                <ProviderRow
                  key={kind}
                  kind={kind}
                  provider={getProvider(channel, kind)}
                  models={resolveSelectableModels(sitePolicy, models[kind] ?? getProvider(channel, kind).models ?? [])}
                  busy={busyKind === kind}
                  disabled={busyKind !== null || sharedChannelSelected || !personalChannelEditable}
                  onPull={() => void pullModels(kind)}
                  onChange={(patch) => updateProvider(kind, patch)}
                />
              ))}
              </div>
            </>}
          </section>

          <section className="ob-settings-section mb-5" data-section-id="generation">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><Palette size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.generationPreferences")}</div>
                <div className="ob-settings-section-desc">{t("settings.generationPreferencesDescription")}</div>
              </div>
            </div>
            <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
            <div>
              {canManageSitePolicy ? (
                <>
                  <Field label={t("settings.globalSystemPrompt")}>
                    <textarea
                      className="ob-field min-h-28 resize-y"
                      maxLength={SYSTEM_PROMPT_MAX_LENGTH}
                      value={config.systemPrompt}
                      onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
                      placeholder={t("settings.globalSystemPromptPlaceholder")}
                    />
                  </Field>
                  <Field label={t("settings.workflowSystemPrompt")}>
                    <textarea
                      className="ob-field min-h-24 resize-y"
                      maxLength={SYSTEM_PROMPT_MAX_LENGTH}
                      value={config.workflowAgentSystemPrompt ?? ""}
                      onChange={(e) => setConfig({ ...config, workflowAgentSystemPrompt: e.target.value })}
                      placeholder={t("settings.workflowSystemPromptPlaceholder")}
                    />
                  </Field>
                  <p className="mb-3 text-xs text-[var(--ob-muted)]">
                    {t("settings.tenantPromptHint")}
                  </p>
                </>
              ) : (
                <div className="mb-3 rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_70%,transparent)] px-3 py-3 text-xs text-[var(--ob-muted)]">
                  <p className="font-medium text-[var(--ob-ink)]">{t("settings.promptManaged")}</p>
                  <p className="mt-1">
                    {t("settings.promptManagedHint")}
                  </p>
                  {config.systemPrompt.trim() ? (
                    <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[var(--ob-ink)]/80" title={config.systemPrompt}>
                      {t("settings.activePrompt", { prompt: config.systemPrompt.trim() })}
                    </p>
                  ) : (
                    <p className="mt-2">{t("settings.noPrompt")}</p>
                  )}
                </div>
              )}
            </div>
            <div className="grid content-start grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-8 lg:grid-cols-1">
              <Field label={t("settings.imageSize")}>
                <select className="ob-field" value={imageSize} onChange={(e) => setConfig({ ...config, imageSize: e.target.value })}>
                  {optionsWithCurrentValue(imageSizeOptions, imageSize).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("settings.imageQuality")}>
                <select className="ob-field" value={imageQuality} onChange={(e) => setConfig({ ...config, imageQuality: e.target.value })}>
                  {optionsWithCurrentValue(imageQualityOptions, imageQuality).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("settings.defaultCount")}>
                <input className="ob-field" type="number" min={1} max={8} value={config.imageCount} onChange={(e) => setConfig({ ...config, imageCount: Number(e.target.value) || 1 })} />
              </Field>
              <p className="text-xs text-[var(--ob-muted)] sm:col-span-3 lg:col-span-1">
                {t("settings.imageOptionsHint")}
              </p>
            </div>
            </div>
          </section>


          <section className="ob-settings-section mb-5" data-section-id="defaults">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><Sliders size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.generationDefaults")}</div>
                <div className="ob-settings-section-desc">{t("settings.generationDefaultsDescription")}</div>
              </div>
            </div>
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              {t("settings.generationDefaultsHint")}
            </p>
            <GenerationDefaultsEditor
              value={config.generationDefaults ?? DEFAULT_GENERATION_DEFAULTS}
              audioProtocol={getProvider(channel, "audio").protocol}
              onChange={(generationDefaults) => setConfig({ ...config, generationDefaults })}
            />
          </section>

          {canManageSitePolicy ? (
            <section className="ob-settings-section mb-5" data-section-id="policy">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><ShieldCheck size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.sitePolicy")}</div>
                <div className="ob-settings-section-desc">{t("settings.sitePolicyDescription")}</div>
              </div>
            </div>
              <p className="mb-3 text-xs text-[var(--ob-muted)]">
                {t("settings.sitePolicyHint")}
              </p>
              {!sitePolicyLoaded ? (
                <p className="text-xs text-[var(--ob-muted)]">{t("settings.loadingPolicy")}</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sitePolicy.allowRegister}
                      aria-label={t("settings.allowRegistration")}
                      className="ob-switch"
                      data-checked={sitePolicy.allowRegister ? "true" : "false"}
                      disabled={sitePolicyBusy}
                      onClick={() => void toggleSitePolicy("allowRegister")}
                    />
                    <span className="text-sm text-[var(--ob-ink)]">{t("settings.allowRegistration")}</span>
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sitePolicy.allowCustomChannel}
                      aria-label={t("settings.allowCustomChannels")}
                      className="ob-switch"
                      data-checked={sitePolicy.allowCustomChannel ? "true" : "false"}
                      disabled={sitePolicyBusy}
                      onClick={() => void toggleSitePolicy("allowCustomChannel")}
                    />
                    <span className="text-sm text-[var(--ob-ink)]">{t("settings.allowCustomChannels")}</span>
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sitePolicy.allowCloudChannel}
                      aria-label={t("settings.allowCloudGeneration")}
                      className="ob-switch"
                      data-checked={sitePolicy.allowCloudChannel ? "true" : "false"}
                      disabled={sitePolicyBusy}
                      onClick={() => void toggleSitePolicy("allowCloudChannel")}
                    />
                    <span className="text-sm text-[var(--ob-ink)]">{t("settings.allowCloudGeneration")}</span>
                  </label>
                </div>
              )}
              {!sitePolicy.allowCustomChannel ? (
                <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("settings.customChannelDisabledHint")}</p>
              ) : null}
              {!sitePolicy.allowCloudChannel ? (
                <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("settings.cloudGenerationDisabledHint")}</p>
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

          <section className="ob-settings-section mb-5" data-section-id="toolbar">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><MousePointerClick size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.imageToolbarTitle")}</div>
                <div className="ob-settings-section-desc">{t("settings.imageToolbarDescription")}</div>
              </div>
            </div>
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              {t("settings.imageToolbarHint")}
            </p>
            <ImageToolbarPreferencesEditor
              value={config.imageToolbar}
              onChange={(imageToolbar) => setConfig({ ...config, imageToolbar })}
            />
          </section>

          <section className="ob-settings-section mb-5" data-section-id="storage">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><HardDrive size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.objectStorageTitle")}</div>
                <div className="ob-settings-section-desc">{t("settings.objectStorageDescription")}</div>
              </div>
            </div>
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              {t("settings.objectStorageHint")}
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
              <span className="text-sm text-[var(--ob-muted)]">{t("settings.enableObjectStorage")}</span>
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
                  name="openboard-object-storage-access-key-id"
                  autoComplete="off"
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
                  name="openboard-object-storage-secret-access-key"
                  autoComplete="new-password"
                  value={config.objectStorage?.secretAccessKey ?? ""}
                  onChange={(e) => setConfig({
                    ...config,
                    objectStorage: { ...(config.objectStorage ?? createDefaultObjectStorage()), secretAccessKey: e.target.value },
                  })}
                />
              </Field>
              <Field label={t("settings.sessionToken")}>
                <input
                  className="ob-field"
                  type="password"
                  name="openboard-object-storage-session-token"
                  autoComplete="new-password"
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
                {t("settings.allowLoopback")}
              </label>
            </div>
            {(() => {
              const validation = validateObjectStorageConfig(normalizeObjectStorage(config.objectStorage));
              return validation ? <p className="mt-2 text-xs text-[var(--ob-danger)]">{validation}</p> : null;
            })()}
          </section>
          <section className="ob-settings-section mb-5" data-section-id="configfile">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><FolderCog size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.configTitle")}</div>
                <div className="ob-settings-section-desc">{t("settings.configDescription")}</div>
              </div>
            </div>
            <p className="mb-3 text-xs text-[var(--ob-muted)]">
              {t("settings.configHint")}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="ob-btn"
                onClick={() => {
                  const payload = JSON.stringify(exportConfigFile(
                    useBoardStore.getState().config,
                  ), null, 2);
                  const url = URL.createObjectURL(new Blob([payload], {
                    type: "application/json",
                  }));
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = "openboard-config.json";
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <CloudDownload size={15} /> {t("settings.exportConfig")}
              </button>
              <label className="ob-btn cursor-pointer">
                <CloudUpload size={15} /> {t("settings.importConfig")}
                <input
                  type="file"
                  aria-label={t("settings.importConfigLabel")}
                  accept="application/json,.json"
                  className="hidden"
                  disabled={!canManageSitePolicy && !sitePolicyLoaded}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void file.text().then(async (raw) => {
                      const state = useBoardStore.getState();
                      const previous = structuredClone(state.config);
                      const next = importConfigFile(raw, state.config);
                      if (!canManageSitePolicy && !sitePolicy.allowCustomChannel &&
                        !hasSameChannelConfiguration(state.config, next)) {
                        throw new Error(t("settings.channelImportLocked"));
                      }
                      state.setConfig(next);
                      const applied = useBoardStore.getState().config;
                      try {
                        await state.flushConfig();
                      } catch (cause) {
                        if (useBoardStore.getState().config === applied) {
                          useBoardStore.getState().setConfig(previous);
                          await useBoardStore.getState().flushConfig().catch(() => undefined);
                        }
                        throw cause;
                      }
                      alert(t("settings.importSuccess"));
                    }).catch((cause) => {
                      alert(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                />
              </label>
            </div>
          </section>
          <section className="ob-settings-section mb-5" data-section-id="webdav">
            <div className="ob-settings-section-header">
              <span className="ob-settings-section-icon"><Database size={14} /></span>
              <div>
                <div className="ob-settings-section-title">{t("settings.webdavTitle")}</div>
                <div className="ob-settings-section-desc">{t("settings.webdavDescription")}</div>
              </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-[1.4fr_0.7fr_0.7fr]">
              <Field label="WebDAV URL">
                <input className="ob-field" value={config.webdavUrl ?? ""} onChange={(e) => setConfig({ ...config, webdavUrl: e.target.value })} placeholder="https://example.com/dav/openboard" />
              </Field>
              <Field label={t("settings.username")}>
                <input className="ob-field" name="openboard-webdav-user" autoComplete="off" value={config.webdavUser ?? ""} onChange={(e) => setConfig({ ...config, webdavUser: e.target.value })} />
              </Field>
              <Field label={t("settings.password")}>
                <input className="ob-field" name="openboard-webdav-password" autoComplete="new-password" type="password" value={config.webdavPass ?? ""} onChange={(e) => setConfig({ ...config, webdavPass: e.target.value })} />
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
                        if (!project) throw new Error(t("settings.canvasBackupMissing"));
                        const bundle = await exportCompleteProjectBundle(project);
                        await webdavPutBlob(state.config, "openboard-current.openboard", bundle);
                        alert(t("settings.uploadCanvasSuccess"));
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <CloudUpload size={15} /> {t("settings.uploadCanvas")}
                </button>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        const state = useBoardStore.getState();
                        const bundle = await exportCompleteWorkspaceBundle({
                          projects: state.projects,
                          assets: state.assets,
                          prompts: state.prompts,
                          config: state.config,
                          generationJobs: await listAllGenerationJobs(),
                          workflowTemplates: await loadPersonalWorkflowTemplates(),
                        });
                        await webdavPutBlob(state.config, "openboard-workspace.obundle", bundle);
                        alert(t("settings.uploadWorkspaceSuccess"));
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <CloudUpload size={15} /> {t("settings.uploadWorkspace")}
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
                        await importCompleteProjectBundle(blob);
                        alert(t("settings.importCanvasSuccess"));
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <CloudDownload size={15} /> {t("settings.importCloudCanvas")}
                </button>
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        if (!confirm(t("settings.confirmRestoreWorkspace"))) return;
                        const state = useBoardStore.getState();
                        const blob = await webdavGetBlob(state.config, "openboard-workspace.obundle");
                        await importCompleteWorkspaceBundle(blob, state.config);
                        alert(t("settings.restoreWorkspaceSuccess"));
                      } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  <RotateCcw size={15} /> {t("settings.restoreWorkspace")}
                </button>
            </div>
          </section>

          {error ? <p role="alert" className="mt-4 rounded-md bg-[color-mix(in_srgb,var(--ob-danger)_12%,transparent)] px-3 py-2 text-[var(--ob-danger)]">{error}</p> : null}
          <div className="mt-5 flex items-start gap-2 border-t border-[var(--ob-line)] pt-4 text-xs text-[var(--ob-muted)]">
            <ShieldCheck className="mt-0.5 shrink-0" size={15} />
            <p>{t("settings.securityHint")}</p>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SharedChannelManagedNotice({ channelName }: { channelName: string }) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] px-4 py-3 text-sm">
      <p className="font-medium">{channelName}</p>
      <p className="mt-1 text-xs text-[var(--ob-muted)]">
        {t("settings.sharedManaged")}
      </p>
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
  const { t } = useI18n();
  const label = t(PROVIDER_LABEL_KEYS[kind]);
  const Icon = kind === "text" ? Type : kind === "image" ? ImageIcon : kind === "video" ? Film : AudioLines;
  const protocolOptions = kind === "audio"
    ? AUDIO_PROTOCOL_OPTIONS
    : [
        { value: "openai", label: "OpenAI" },
        { value: "ark", label: "Ark / Seedance" },
        { value: "gemini", label: "Gemini" },
        { value: "apimart", label: `APIMart (${t("settings.serverOnly")})` },
        { value: "kie", label: `KIE Market (${t("settings.serverOnly")})` },
        { value: "template", label: "Template" },
      ] as const;
  const requiresKey = kind !== "audio" || audioProtocolRequiresKey(provider.protocol);
  const canPullModels = provider.protocol === "openai" || provider.protocol === "apimart";
  return (
    <div
      className="border-b border-[var(--ob-line)] px-3 py-3 last:border-b-0"
      data-provider-kind={kind}
    >
      <div className="grid gap-2 md:grid-cols-[110px_140px_minmax(180px,1.3fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_44px] md:items-center">
        <div className="flex items-center gap-2 font-medium"><Icon size={16} className="text-[var(--ob-accent)]" />{label}</div>
        <CompactField label={t("settings.protocol")}>
          <select className="ob-field" aria-label={`${label} ${t("settings.protocol")}`} value={provider.protocol} disabled={disabled} onChange={(e) => {
            const protocol = e.target.value as typeof provider.protocol;
            onChange(kind === "audio" ? { protocol, ...audioProviderPreset(protocol) } : { protocol });
          }}>
            {protocolOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </CompactField>
        <CompactField label={t("settings.serviceUrl")}>
          <input className="ob-field" aria-label={`${label} URL`} value={provider.baseUrl} disabled={disabled} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder={t("settings.serviceUrl")} />
        </CompactField>
        <CompactField label="API Key">
          <input
            className="ob-field"
            aria-label={`${label} API Key`}
            name={`openboard-${kind}-api-key`}
            type="password"
            autoComplete="new-password"
            value={provider.apiKey}
            disabled={disabled || !requiresKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={requiresKey ? "API Key" : t("settings.noApiKey")}
          />
        </CompactField>
        <CompactField label={t("settings.model")}>
          <input className="ob-field" aria-label={`${label} ${t("settings.model")}`} value={provider.model} disabled={disabled} onChange={(e) => onChange({ model: e.target.value })} placeholder={t("settings.modelName")} />
        </CompactField>
        <button type="button" className="ob-icon-btn disabled:opacity-50" aria-label={t("settings.pullModels", { label })} title={canPullModels ? t("settings.pullModels", { label }) : t("settings.noModelList")} disabled={disabled || !canPullModels} onClick={onPull}>
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
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => (policy.availableModels ?? []).join("\n"));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft((policy.availableModels ?? []).join("\n"));
  }, [policy.availableModels, dirty]);

  const defaults: Array<{ key: keyof SitePolicy; label: string }> = [
    { key: "defaultTextModel", label: t("settings.defaultTextModel") },
    { key: "defaultImageModel", label: t("settings.defaultImageModel") },
    { key: "defaultVideoModel", label: t("settings.defaultVideoModel") },
    { key: "defaultAudioModel", label: t("settings.defaultAudioModel") },
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
        {t("settings.availableModels")}
      </p>
      <textarea
        aria-label={t("settings.availableModelsLabel")}
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
              <option value="">{t("settings.unsetModel")}</option>
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
        {t("settings.saveModelList")}
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
  const { t } = useI18n();
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
        aria-label={t("settings.templateJson")}
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
              setMessage(t("settings.templateApplied"));
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          {t("settings.applyTemplate")}
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
  audioProtocol,
  onChange,
}: {
  value: GenerationDefaults;
  audioProtocol: ReturnType<typeof getProvider>["protocol"];
  onChange: (next: GenerationDefaults) => void;
}) {
  const { t } = useI18n();
  const update = (patch: Partial<GenerationDefaults>) => onChange({ ...value, ...patch });
  const protocolVoices = audioVoiceOptions(audioProtocol);
  const protocolFormats = audioFormatOptions(audioProtocol);
  const voiceOptions = protocolVoices.some((voice) => voice === value.audioVoice)
    ? protocolVoices
    : [value.audioVoice || defaultAudioVoice(audioProtocol), ...protocolVoices];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label={t("settings.defaultVideoRatio")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultVideoRatio")}
          value={value.videoRatio}
          onChange={(event) => update({ videoRatio: event.target.value })}
        >
          {VIDEO_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
      </Field>
      <Field label={t("settings.defaultResolution")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultResolution")}
          value={value.videoResolution}
          onChange={(event) => update({ videoResolution: event.target.value })}
        >
          {VIDEO_RESOLUTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </Field>
      <Field label={t("settings.defaultDuration")}>
        <input
          className="ob-field"
          aria-label={t("settings.defaultDuration")}
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
      <Field label={t("settings.defaultAudioFormat")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultAudioFormat")}
          value={value.audioFormat}
          onChange={(event) => update({ audioFormat: event.target.value })}
        >
          {(protocolFormats.includes(value.audioFormat) ? protocolFormats : [value.audioFormat, ...protocolFormats])
            .map((format) => <option key={format} value={format}>{format}</option>)}
        </select>
      </Field>
      <Field label={t("settings.defaultVoice")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultVoice")}
          value={value.audioVoice}
          onChange={(event) => update({ audioVoice: event.target.value })}
        >
          {voiceOptions.map((voice) => <option key={voice} value={voice}>{audioVoiceLabel(voice)}</option>)}
        </select>
      </Field>
      <Field label={t("settings.defaultSpeed")}>
        <input
          className="ob-field"
          aria-label={t("settings.defaultSpeed")}
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
          placeholder={t("settings.speedPlaceholder")}
        />
      </Field>
      <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
        <button
          type="button"
          role="switch"
          aria-checked={value.videoGenerateAudio}
          aria-label={t("settings.defaultGenerateAudio")}
          className="ob-switch"
          data-checked={value.videoGenerateAudio ? "true" : "false"}
          onClick={() => update({ videoGenerateAudio: !value.videoGenerateAudio })}
        />
        <span className="text-sm text-[var(--ob-ink)]">{t("settings.defaultGenerateAudio")}</span>
      </label>
      <label className="flex items-center gap-2 rounded-xl border border-[var(--ob-line)] px-3 py-2">
        <button
          type="button"
          role="switch"
          aria-checked={value.videoWatermark}
          aria-label={t("settings.defaultWatermark")}
          className="ob-switch"
          data-checked={value.videoWatermark ? "true" : "false"}
          onClick={() => update({ videoWatermark: !value.videoWatermark })}
        />
        <span className="text-sm text-[var(--ob-ink)]">{t("settings.defaultWatermark")}</span>
      </label>
      <Field label={audioProtocol === "openai" ? t("settings.defaultInstructions") : t("settings.defaultInstructionsOpenAI")}>
        <input
          className="ob-field"
          aria-label={t("settings.defaultInstructions")}
          disabled={audioProtocol !== "openai"}
          maxLength={2_000}
          value={value.audioInstructions}
          onChange={(event) => update({ audioInstructions: event.target.value })}
          placeholder={audioProtocol === "openai" ? t("settings.instructionsEmpty") : t("settings.instructionsUnsupported")}
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
