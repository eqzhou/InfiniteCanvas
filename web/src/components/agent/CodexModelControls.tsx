import type { CodexModel } from "@/services/local-agent";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

export function resolveCodexReasoningEffort(model: CodexModel, preferred = ""): string {
  if (!model.supportedReasoningEfforts.length) return "";
  if (model.supportedReasoningEfforts.some((item) => item.reasoningEffort === preferred)) {
    return preferred;
  }
  if (model.supportedReasoningEfforts.some(
    (item) => item.reasoningEffort === model.defaultReasoningEffort,
  )) {
    return model.defaultReasoningEffort;
  }
  return model.supportedReasoningEfforts[0]?.reasoningEffort ?? "";
}

export function CodexModelControls({
  models,
  model,
  effort,
  disabled,
  error,
  loading,
  onModelChange,
  onEffortChange,
}: {
  models: readonly CodexModel[];
  model: string;
  effort: string;
  disabled: boolean;
  error?: string;
  loading: boolean;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
}) {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  const selected = models.find((item) => item.model === model);
  if (!models.length) {
    return loading ? (
      <p className="mb-1 px-1 text-[9px] text-[var(--ob-muted)]">{t("agent.loadingModels")}</p>
    ) : error ? (
      <p className="mb-1 px-1 text-[9px] text-[var(--ob-muted)]" title={error}>
        {t("agent.modelsUnavailable", { message: error })}
      </p>
    ) : (
      <p className="mb-1 px-1 text-[9px] text-[var(--ob-muted)]">{t("agent.noModels")}</p>
    );
  }
  return (
    <div className="mb-1 grid grid-cols-2 gap-1.5 px-1">
      <label className="min-w-0 text-[9px] text-[var(--ob-muted)]">
        {t("agent.model")}
        <select
          aria-label={t("agent.codexModel")}
          className="mt-0.5 w-full rounded-md border border-[var(--ob-line)] bg-[var(--ob-panel)] px-1 py-0.5 text-[10px] text-[var(--ob-ink)]"
          disabled={disabled}
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
        >
          {models.map((item) => (
            <option key={item.id} value={item.model}>{item.displayName}</option>
          ))}
        </select>
      </label>
      <label className="min-w-0 text-[9px] text-[var(--ob-muted)]">
        {t("agent.effort")}
        <select
          aria-label={t("agent.reasoningEffort")}
          className="mt-0.5 w-full rounded-md border border-[var(--ob-line)] bg-[var(--ob-panel)] px-1 py-0.5 text-[10px] text-[var(--ob-ink)]"
          disabled={disabled || !selected?.supportedReasoningEfforts.length}
          value={effort}
          onChange={(event) => onEffortChange(event.target.value)}
        >
          {selected?.supportedReasoningEfforts.map((item) => (
            <option key={item.reasoningEffort} value={item.reasoningEffort} title={item.description}>
              {item.reasoningEffort}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
