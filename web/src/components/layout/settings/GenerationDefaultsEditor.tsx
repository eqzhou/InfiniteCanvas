import { getProvider } from "@/lib/ai-config";
import {
  DEFAULT_GENERATION_DEFAULTS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  type GenerationDefaults,
} from "@/lib/generation-defaults";
import {
  audioFormatOptions,
  audioVoiceLabel,
  audioVoiceOptions,
  defaultAudioVoice,
} from "@/lib/audio-provider";
import { useI18n } from "@/i18n/I18nProvider";
import { SettingsField } from "./SettingsField";

/**
 * Editor for the tenant generation defaults new video and audio nodes inherit.
 * Each control writes the whole normalized object so a partial value can never
 * be persisted, and the input is never mutated in place.
 */
export function GenerationDefaultsEditor({
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
      <SettingsField label={t("settings.defaultVideoRatio")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultVideoRatio")}
          value={value.videoRatio}
          onChange={(event) => update({ videoRatio: event.target.value })}
        >
          {VIDEO_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
      </SettingsField>
      <SettingsField label={t("settings.defaultResolution")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultResolution")}
          value={value.videoResolution}
          onChange={(event) => update({ videoResolution: event.target.value })}
        >
          {VIDEO_RESOLUTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </SettingsField>
      <SettingsField label={t("settings.defaultDuration")}>
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
      </SettingsField>
      <SettingsField label={t("settings.defaultAudioFormat")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultAudioFormat")}
          value={value.audioFormat}
          onChange={(event) => update({ audioFormat: event.target.value })}
        >
          {(protocolFormats.includes(value.audioFormat) ? protocolFormats : [value.audioFormat, ...protocolFormats])
            .map((format) => <option key={format} value={format}>{format}</option>)}
        </select>
      </SettingsField>
      <SettingsField label={t("settings.defaultVoice")}>
        <select
          className="ob-field"
          aria-label={t("settings.defaultVoice")}
          value={value.audioVoice}
          onChange={(event) => update({ audioVoice: event.target.value })}
        >
          {voiceOptions.map((voice) => <option key={voice} value={voice}>{audioVoiceLabel(voice)}</option>)}
        </select>
      </SettingsField>
      <SettingsField label={t("settings.defaultSpeed")}>
        <input
          className="ob-field"
          aria-label={t("settings.defaultSpeed")}
          type="number"
          min={0}
          max={4}
          step={0.05}
          value={value.audioSpeed}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            const speed = !Number.isFinite(parsed) || parsed <= 0
              ? 0
              : Math.min(4, Math.max(0.25, parsed));
            update({ audioSpeed: speed });
          }}
          placeholder={t("settings.speedPlaceholder")}
        />
      </SettingsField>
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
      <SettingsField label={audioProtocol === "openai" ? t("settings.defaultInstructions") : t("settings.defaultInstructionsOpenAI")}>
        <input
          className="ob-field"
          aria-label={t("settings.defaultInstructions")}
          disabled={audioProtocol !== "openai"}
          maxLength={2_000}
          value={value.audioInstructions}
          onChange={(event) => update({ audioInstructions: event.target.value })}
          placeholder={audioProtocol === "openai" ? t("settings.instructionsEmpty") : t("settings.instructionsUnsupported")}
        />
      </SettingsField>
    </div>
  );
}
