import { useEffect, useState } from "react";
import { Plus, Radio, Server } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { createDefaultChannel } from "@/lib/defaults";
import { getProvider, normalizeChannel } from "@/lib/ai-config";
import { listModels } from "@/services/ai-client";
import { reconcileProviderModel, resolveSelectableModels } from "@/lib/model-catalog";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import { audioFormatOptions, defaultAudioVoice } from "@/lib/audio-provider";
import { clampImageCountForProvider } from "@/lib/image-generation-options";
import { personalChannelEditableFor, type SettingsPolicyLoad } from "@/lib/settings-navigation";
import { resolveActiveAIChannel, useSharedChannels } from "@/services/shared-channels";
import type { TenantPolicy } from "@/services/auth-session";
import type { AiProviderKind } from "@/types/board";
import { useI18n } from "@/i18n/I18nProvider";
import { SettingsField } from "./SettingsField";
import { ProviderRow } from "./ProviderRow";
import type { SettingsNoticeHandlers } from "./settings-notices";

const PROVIDER_KINDS: AiProviderKind[] = ["text", "image", "video", "audio"];

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

export function SettingsModelsSection({
  tenantOwner,
  policyLoad,
  tenantPolicy,
  notices,
}: {
  tenantOwner: boolean;
  policyLoad: SettingsPolicyLoad;
  tenantPolicy: TenantPolicy;
  notices: SettingsNoticeHandlers;
}) {
  const { t } = useI18n();
  const channels = useBoardStore((state) => state.config.channels);
  const activeChannelId = useBoardStore((state) => state.config.activeChannelId);
  const activeSharedChannelId = useBoardStore((state) => state.config.activeSharedChannelId);
  const setConfig = useBoardStore((state) => state.setConfig);
  const flushConfig = useBoardStore((state) => state.flushConfig);
  const sharedChannels = useSharedChannels();
  const [models, setModels] = useState<Partial<Record<AiProviderKind, string[]>>>({});
  const [busyKind, setBusyKind] = useState<AiProviderKind | null>(null);

  const channel = resolveActiveAIChannel(
    channels,
    activeChannelId,
    sharedChannels,
    activeSharedChannelId,
  ) ?? channels[0];
  const sharedChannelSelected = Boolean(activeSharedChannelId);
  const selectedSharedChannelAvailable = !sharedChannelSelected
    || sharedChannels.some((item) => item.id === activeSharedChannelId);
  const personalChannelEditable = personalChannelEditableFor(
    tenantOwner,
    policyLoad,
    tenantPolicy.allowCustomChannel,
  );

  useEffect(() => {
    const active = resolveActiveAIChannel(
      channels,
      activeChannelId,
      sharedChannels,
      activeSharedChannelId,
    ) ?? channels[0];
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
  }, [activeChannelId, activeSharedChannelId, channels, sharedChannels]);

  const updateChannel = (patch: Partial<typeof channel>) => {
    if (!channel || sharedChannelSelected || !personalChannelEditable) return;
    setConfig({
      ...useBoardStore.getState().config,
      channels: useBoardStore.getState().config.channels.map((item) =>
        item.id === channel.id ? { ...item, ...patch } : item,
      ),
    });
  };

  const updateProvider = (kind: AiProviderKind, patch: Partial<ReturnType<typeof getProvider>>) => {
    if (!channel || !personalChannelEditable) return;
    const config = useBoardStore.getState().config;
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
    const image = providers.image;
    setConfig({
      ...config,
      channels: config.channels.map((item) => item.id === channel.id ? { ...item, providers } : item),
      generationDefaults,
      imageCount: clampImageCountForProvider(config.imageCount, image.protocol, image.model),
    });
  };

  const pullModels = async (kind: AiProviderKind) => {
    if (!channel) return;
    setBusyKind(kind);
    notices.setError(null);
    try {
      await flushConfig();
      const list = await listModels(channel, kind);
      setModels((current) => ({ ...current, [kind]: list }));
      if (!list.length) {
        notices.setError(t("settings.modelsNotFound"));
        return;
      }
      const selectable = resolveSelectableModels(tenantPolicy, list);
      const current = getProvider(channel, kind).model;
      const reconciled = reconcileProviderModel(tenantPolicy, kind, current, selectable);
      updateProvider(kind, {
        models: list,
        ...(reconciled !== current ? { model: reconciled } : {}),
      });
    } catch (cause) {
      notices.setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <section className="ob-settings-section mb-5" data-section-id="models">
      <div className="ob-settings-section-header">
        <span className="ob-settings-section-icon"><Server size={14} /></span>
        <div>
          <div className="ob-settings-section-title">{t("settings.modelsAndChannels")}</div>
          <div className="ob-settings-section-desc">{t("settings.modelsAndChannelsDescription")}</div>
        </div>
      </div>
      <p className="mb-3 text-xs text-[var(--ob-muted)]">{t("settings.channelHint")}</p>
      {policyLoad === "unavailable" && !tenantOwner ? (
        <p className="mb-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-accent-soft)] px-3 py-2 text-xs text-[var(--ob-muted)]">
          {t("settings.policyUnavailable")}
        </p>
      ) : null}
      <div className="mb-5 grid gap-3 sm:grid-cols-[minmax(180px,0.8fr)_minmax(220px,1.1fr)_minmax(130px,0.5fr)_40px]">
        <SettingsField label={t("settings.currentChannel")}>
          <select
            className="ob-field"
            aria-label={t("settings.currentChannel")}
            disabled={!channel}
            value={activeSharedChannelId ? `shared:${activeSharedChannelId}` : `personal:${activeChannelId ?? ""}`}
            onChange={(event) => {
              const [scope, id] = event.target.value.split(":", 2);
              const config = useBoardStore.getState().config;
              const nextConfig = scope === "shared"
                ? { ...config, activeChannelId: null, activeSharedChannelId: id }
                : { ...config, activeChannelId: id, activeSharedChannelId: null };
              const nextChannel = resolveActiveAIChannel(
                nextConfig.channels,
                nextConfig.activeChannelId,
                sharedChannels,
                nextConfig.activeSharedChannelId,
              );
              if (!nextChannel) {
                setConfig(nextConfig);
                return;
              }
              const image = getProvider(nextChannel, "image");
              setConfig({
                ...nextConfig,
                imageCount: clampImageCountForProvider(config.imageCount, image.protocol, image.model),
              });
            }}
          >
            {sharedChannelSelected && !selectedSharedChannelAvailable ? (
              <option value={`shared:${activeSharedChannelId}`}>{t("settings.sharedUnavailable")}</option>
            ) : null}
            {channels.map((item) => (
              <option key={item.id} value={`personal:${item.id}`}>{item.name} {t("settings.personalSuffix")}</option>
            ))}
            {sharedChannels.filter((item) => !channels.some((personal) => personal.id === item.id)).map((item) => (
              <option key={item.id} value={`shared:${item.id}`}>
                {item.name} · {item.source === "platform" ? t("settings.channelSourcePlatform") : item.source === "automatic" ? t("settings.channelSourceAutomatic") : t("settings.channelSourceTenant")}
              </option>
            ))}
          </select>
        </SettingsField>
        <SettingsField label={t("settings.channelName")}>
          <input
            className="ob-field"
            value={channel?.name ?? ""}
            disabled={!channel || sharedChannelSelected || !personalChannelEditable}
            title={!personalChannelEditable ? t("settings.memberChannelLocked") : undefined}
            onChange={(event) => updateChannel({ name: event.target.value })}
          />
        </SettingsField>
        <SettingsField label={t("settings.timeout")}>
          <input
            className="ob-field"
            type="number"
            min={1}
            max={600}
            step={1}
            value={sharedChannelSelected ? (channel?.timeoutSeconds ?? "") : (channel?.timeoutSeconds ?? 60)}
            placeholder={sharedChannelSelected ? t("settings.adminConfigured") : "60"}
            disabled={!channel || sharedChannelSelected || !personalChannelEditable}
            title={sharedChannelSelected
              ? t("settings.sharedTimeoutHint")
              : !personalChannelEditable
                ? t("settings.memberChannelLocked")
                : t("settings.timeoutHint")}
            onChange={(event) => updateChannel({ timeoutSeconds: Number(event.target.value) })}
          />
        </SettingsField>
        <button
          type="button"
          aria-label={t("settings.addChannel")}
          title={personalChannelEditable ? t("settings.addChannel") : t("settings.customChannelsDisabled")}
          className="ob-icon-btn mt-5 transition-colors duration-200"
          disabled={!personalChannelEditable}
          onClick={() => {
            if (!personalChannelEditable) {
              notices.setError(t("settings.customChannelDisabledError"));
              return;
            }
            const next = createDefaultChannel();
            const config = useBoardStore.getState().config;
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

      <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--ob-muted)]">
        <Radio size={12} />
        {t("settings.modelServices")}
      </div>
      {sharedChannelSelected ? (
        <SharedChannelManagedNotice channelName={selectedSharedChannelAvailable && channel ? channel.name : t("settings.sharedUnavailable")} />
      ) : (
        <>
          {policyLoad === "ready" && !personalChannelEditable ? (
            <p className="mb-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-accent-soft)] px-3 py-2 text-xs text-[var(--ob-muted)]">
              {t("settings.memberChannelsDisabled")}
            </p>
          ) : null}
          {channel ? <div className="overflow-hidden rounded-xl border border-[var(--ob-line)] shadow-[var(--ob-elev-1)]">
            <div className="hidden grid-cols-[110px_140px_minmax(180px,1.3fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_44px] gap-2 border-b border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_80%,var(--ob-panel))] px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ob-muted)] md:grid">
              <span>{t("settings.capability")}</span><span>{t("settings.protocol")}</span><span>{t("settings.serviceUrl")}</span><span>{t("settings.apiKey")}</span><span>{t("settings.model")}</span><span />
            </div>
            {PROVIDER_KINDS.map((kind) => (
              <ProviderRow
                key={kind}
                kind={kind}
                provider={getProvider(channel, kind)}
                models={resolveSelectableModels(tenantPolicy, models[kind] ?? getProvider(channel, kind).models ?? [])}
                busy={busyKind === kind}
                disabled={busyKind !== null || sharedChannelSelected || !personalChannelEditable}
                onPull={() => void pullModels(kind)}
                onChange={(patch) => updateProvider(kind, patch)}
              />
            ))}
          </div> : null}
        </>
      )}
    </section>
  );
}
