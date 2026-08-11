import { useEffect, useMemo, useState } from "react";
import { ImagePlus, RefreshCw, Square } from "lucide-react";

import type { GenerationJob } from "@/types/board";
import { parseWorkflowRunParameters, parseWorkflowRunResult } from "@/lib/workflow-job";
import { resolveObjectUrl } from "@/services/storage";
import { useI18n } from "@/i18n/I18nProvider";

export function WorkflowRunCard({
  job,
  busy,
  onCancel,
  onRetry,
  onInsert,
}: {
  job: GenerationJob;
  busy?: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onInsert: (storageKeys: string[]) => void;
}) {
  const { t } = useI18n();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const parsed = useMemo(() => {
    const parameters = parseWorkflowRunParameters(job.parameters);
    return { parameters, result: parseWorkflowRunResult(job.result, parameters.templateSnapshot) };
  }, [job]);
  const allKeys = useMemo(() => [...new Set(Object.values(parsed.result.steps).flatMap((step) => step.storageKeys ?? []))], [parsed.result]);

  useEffect(() => {
    let active = true;
    void Promise.all(allKeys.map(async (key) => [key, await resolveObjectUrl(key.startsWith("media:") ? "media" : "image", key)] as const))
      .then((entries) => {
        if (active) setUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))));
      });
    return () => { active = false; };
  }, [allKeys.join("\u0000")]);

  return (
    <article className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 shadow-[var(--ob-elev-1)]">
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{parsed.parameters.templateSnapshot.title}</h3>
          <p className="text-xs text-[var(--ob-muted)]">{t(`workflow.status.${job.status}`)} · {new Date(job.createdAt).toLocaleString()}</p>
        </div>
        <span className="rounded-full bg-[var(--ob-accent-soft)] px-2 py-1 text-[11px] text-[var(--ob-accent)]">
          {Object.values(parsed.result.steps).filter((step) => step.status === "succeeded").length}/{parsed.parameters.templateSnapshot.steps.length}
        </span>
      </div>
      <ol className="mb-3 space-y-1" aria-label={t("workflow.stepStatus")}>
        {parsed.parameters.templateSnapshot.steps.map((step) => {
          const state = parsed.result.steps[step.id]!;
          return <li key={step.id} className="flex items-center gap-2 text-xs"><span className="w-16 shrink-0 text-[var(--ob-muted)]">{state.status}</span><span className="truncate">{step.title}</span></li>;
        })}
      </ol>
      {allKeys.length ? (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {allKeys.map((key) => urls[key] ? <img key={key} src={urls[key]} alt={t("workflow.resultAlt")} className="aspect-square rounded-lg object-cover" /> : <div key={key} className="aspect-square animate-pulse rounded-lg bg-[var(--ob-canvas)]" />)}
        </div>
      ) : null}
      {job.error ? <p role="alert" className="mb-3 text-xs text-[var(--ob-danger)]">{job.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {(job.status === "queued" || job.status === "running") ? (
          <button type="button" className="ob-btn-danger inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs" onClick={onCancel}><Square size={13} />{t("workflow.cancel")}</button>
        ) : null}
        {(job.status === "failed" || job.status === "cancelled") ? (
          <button type="button" className="ob-btn-secondary inline-flex items-center gap-1 px-3 py-2 text-xs" disabled={busy} onClick={onRetry}><RefreshCw size={13} />{t("workflow.retrySnapshot")}</button>
        ) : null}
        {job.status === "succeeded" && parsed.result.outputStorageKeys.length ? (
          <button type="button" className="ob-btn-primary inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs" disabled={busy}
            onClick={() => onInsert(parsed.result.outputStorageKeys)}><ImagePlus size={13} />{t("workflow.insertResults")}</button>
        ) : null}
      </div>
    </article>
  );
}
