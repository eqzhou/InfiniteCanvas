import type { CodexModel } from "@/services/local-agent";

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
  const selected = models.find((item) => item.model === model);
  if (!models.length) {
    return loading ? (
      <p className="mb-1 px-1 text-[9px] text-[var(--ob-muted)]">正在读取当前账号模型…</p>
    ) : error ? (
      <p className="mb-1 px-1 text-[9px] text-[var(--ob-muted)]" title={error}>
        模型目录暂不可用，将使用 Codex 默认设置
      </p>
    ) : (
      <p className="mb-1 px-1 text-[9px] text-[var(--ob-muted)]">当前账号未返回可选模型，将使用 Codex 默认设置</p>
    );
  }
  return (
    <div className="mb-1 grid grid-cols-2 gap-1.5 px-1">
      <label className="min-w-0 text-[9px] text-[var(--ob-muted)]">
        模型
        <select
          aria-label="Codex 模型"
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
        推理强度
        <select
          aria-label="Codex 推理强度"
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
