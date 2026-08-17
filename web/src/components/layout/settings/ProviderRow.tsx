import { useEffect, useState } from "react";
import { AudioLines, Film, Image as ImageIcon, RefreshCw, Type } from "lucide-react";
import type { AiProviderKind, AiTemplateConfig } from "@/types/board";
import { getProvider } from "@/lib/ai-config";
import {
  AUDIO_PROTOCOL_OPTIONS,
  audioProtocolRequiresKey,
  audioProviderPreset,
} from "@/lib/audio-provider";
import { validateProviderTemplate } from "@/lib/provider-template";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";
import { SettingsCompactField } from "./SettingsField";

const PROVIDER_LABEL_KEYS: Record<AiProviderKind, MessageKey> = {
  text: "common.text",
  image: "common.image",
  video: "common.video",
  audio: "common.audio",
};

export function ProviderRow({
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
        <SettingsCompactField label={t("settings.protocol")}>
          <select className="ob-field" aria-label={`${label} ${t("settings.protocol")}`} value={provider.protocol} disabled={disabled} onChange={(event) => {
            const protocol = event.target.value as typeof provider.protocol;
            onChange(kind === "audio" ? { protocol, ...audioProviderPreset(protocol) } : { protocol });
          }}>
            {protocolOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </SettingsCompactField>
        <SettingsCompactField label={t("settings.serviceUrl")}>
          <input className="ob-field" aria-label={`${label} URL`} value={provider.baseUrl} disabled={disabled} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder={t("settings.serviceUrl")} />
        </SettingsCompactField>
        <SettingsCompactField label={t("settings.apiKey")}>
          <input
            className="ob-field"
            aria-label={`${label} ${t("settings.apiKey")}`}
            name={`openboard-${kind}-api-key`}
            type="password"
            autoComplete="new-password"
            value={provider.apiKey}
            disabled={disabled || !requiresKey}
            onChange={(event) => onChange({ apiKey: event.target.value })}
            placeholder={requiresKey ? t("settings.apiKey") : t("settings.noApiKey")}
          />
        </SettingsCompactField>
        <SettingsCompactField label={t("settings.model")}>
          <input className="ob-field" aria-label={`${label} ${t("settings.model")}`} value={provider.model} disabled={disabled} onChange={(event) => onChange({ model: event.target.value })} placeholder={t("settings.modelName")} />
        </SettingsCompactField>
        <button type="button" className="ob-icon-btn disabled:opacity-50 transition-colors duration-200" aria-label={t("settings.pullModels", { label })} title={canPullModels ? t("settings.pullModels", { label }) : t("settings.noModelList")} disabled={disabled || !canPullModels} onClick={onPull}>
          <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
        </button>
      </div>
      {provider.protocol === "template" ? (
        <TemplateEditor disabled={disabled} value={provider.template} onChange={(template) => onChange({ template })} />
      ) : null}
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

function TemplateEditor({
  value,
  disabled,
  onChange,
}: {
  value?: AiTemplateConfig;
  disabled: boolean;
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
  const serialized = JSON.stringify(value ?? fallback, null, 2);
  const [source, setSource] = useState(serialized);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setSource(serialized);
    setMessage("");
  }, [serialized]);
  return (
    <div className="mt-2">
      <textarea
        aria-label={t("settings.templateJson")}
        className="ob-field min-h-40 resize-y font-mono text-xs"
        value={source}
        disabled={disabled}
        onChange={(event) => setSource(event.target.value)}
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className="ob-btn"
          disabled={disabled}
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
