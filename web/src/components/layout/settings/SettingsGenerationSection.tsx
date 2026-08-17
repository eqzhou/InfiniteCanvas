import { Sliders } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { getProvider } from "@/lib/ai-config";
import { SYSTEM_PROMPT_MAX_LENGTH } from "@/lib/app-config";
import {
  clampImageCountForProvider,
  imageOutputLimitFor,
  imageQualityOptionsFor,
  imageSizeOptionsFor,
  normalizeImageQualityForProvider,
  normalizeImageSizeForProvider,
  optionsWithCurrentValue,
} from "@/lib/image-generation-options";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import { resolveActiveAIChannel, useSharedChannels } from "@/services/shared-channels";
import { useI18n } from "@/i18n/I18nProvider";
import { SettingsField } from "./SettingsField";
import { GenerationDefaultsEditor } from "./GenerationDefaultsEditor";

export function SettingsGenerationSection() {
  const { t } = useI18n();
  const systemPrompt = useBoardStore((state) => state.config.systemPrompt);
  const workflowAgentSystemPrompt = useBoardStore((state) => state.config.workflowAgentSystemPrompt);
  const imageSizeValue = useBoardStore((state) => state.config.imageSize);
  const imageQualityValue = useBoardStore((state) => state.config.imageQuality);
  const imageCount = useBoardStore((state) => state.config.imageCount);
  const generationDefaults = useBoardStore((state) => state.config.generationDefaults);
  const channels = useBoardStore((state) => state.config.channels);
  const activeChannelId = useBoardStore((state) => state.config.activeChannelId);
  const activeSharedChannelId = useBoardStore((state) => state.config.activeSharedChannelId);
  const setConfig = useBoardStore((state) => state.setConfig);
  const sharedChannels = useSharedChannels();
  const sharedChannelReady = !activeSharedChannelId
    || sharedChannels.some((item) => item.id === activeSharedChannelId);
  const channel = resolveActiveAIChannel(
    channels,
    activeChannelId,
    sharedChannels,
    activeSharedChannelId,
  ) ?? (sharedChannelReady ? channels[0] : undefined);
  const imageProvider = channel ? getProvider(channel, "image") : undefined;
  const imageQualityOptions = imageQualityOptionsFor(imageProvider?.protocol, imageProvider?.model);
  const imageQuality = normalizeImageQualityForProvider(
    imageQualityValue,
    imageProvider?.protocol,
    imageProvider?.model,
  );
  const imageSizeOptions = imageSizeOptionsFor(imageProvider?.protocol, imageProvider?.model);
  const imageSize = normalizeImageSizeForProvider(imageSizeValue);
  const imageOutputLimit = imageOutputLimitFor(imageProvider?.protocol, imageProvider?.model);
  const displayCount = clampImageCountForProvider(
    imageCount,
    imageProvider?.protocol,
    imageProvider?.model,
  );

  return (
    <section className="ob-settings-section mb-5" data-section-id="generation">
      <div className="ob-settings-section-header">
        <span className="ob-settings-section-icon"><Sliders size={14} /></span>
        <div>
          <div className="ob-settings-section-title">{t("settings.generationDefaults")}</div>
          <div className="ob-settings-section-desc">{t("settings.generationDefaultsDescription")}</div>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <SettingsField label={t("settings.globalSystemPrompt")}>
            <textarea
              className="ob-field min-h-28 resize-y"
              maxLength={SYSTEM_PROMPT_MAX_LENGTH}
              value={systemPrompt}
              onChange={(event) => setConfig({ ...useBoardStore.getState().config, systemPrompt: event.target.value })}
              placeholder={t("settings.globalSystemPromptPlaceholder")}
            />
          </SettingsField>
          <SettingsField label={t("settings.workflowSystemPrompt")}>
            <textarea
              className="ob-field min-h-24 resize-y"
              maxLength={SYSTEM_PROMPT_MAX_LENGTH}
              value={workflowAgentSystemPrompt ?? ""}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                workflowAgentSystemPrompt: event.target.value,
              })}
              placeholder={t("settings.workflowSystemPromptPlaceholder")}
            />
          </SettingsField>
          <p className="mb-3 text-xs text-[var(--ob-muted)]">
            {t("settings.tenantPromptHint")}
          </p>
        </div>
        <div className="grid content-start grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-8 lg:grid-cols-1">
          <SettingsField label={t("settings.imageSize")}>
            <select
              className="ob-field"
              value={imageSize}
              onChange={(event) => setConfig({ ...useBoardStore.getState().config, imageSize: event.target.value })}
            >
              {optionsWithCurrentValue(imageSizeOptions, imageSize).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </SettingsField>
          <SettingsField label={t("settings.imageQuality")}>
            <select
              className="ob-field"
              value={imageQuality}
              onChange={(event) => setConfig({ ...useBoardStore.getState().config, imageQuality: event.target.value })}
            >
              {optionsWithCurrentValue(imageQualityOptions, imageQuality).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </SettingsField>
          <SettingsField label={t("settings.defaultCount")}>
            <input
              className="ob-field"
              type="number"
              min={1}
              max={imageOutputLimit}
              value={displayCount}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                imageCount: clampImageCountForProvider(
                  Number(event.target.value) || 1,
                  imageProvider?.protocol,
                  imageProvider?.model,
                ),
              })}
            />
          </SettingsField>
          <p className="text-xs text-[var(--ob-muted)] sm:col-span-3 lg:col-span-1">
            {t("settings.imageOptionsHint")}
          </p>
        </div>
      </div>
      <p className="mb-3 mt-5 text-xs text-[var(--ob-muted)]">
        {t("settings.generationDefaultsHint")}
      </p>
      <GenerationDefaultsEditor
        value={generationDefaults ?? DEFAULT_GENERATION_DEFAULTS}
        audioProtocol={channel ? getProvider(channel, "audio").protocol : "openai"}
        onChange={(nextDefaults) => setConfig({
          ...useBoardStore.getState().config,
          generationDefaults: nextDefaults,
        })}
      />
    </section>
  );
}
