import { Copy, Plus, Save, Trash2 } from "lucide-react";

import type { WorkflowStep, WorkflowTemplate, WorkflowVariable } from "@/types/workflow";
import { useI18n } from "@/i18n/I18nProvider";

type Translate = ReturnType<typeof useI18n>["t"];

function variableForKind(id: string, kind: WorkflowVariable["kind"], t: Translate): WorkflowVariable {
  if (kind === "select") return { id, kind, label: t("workflow.default.selectLabel"), required: true, options: [t("workflow.default.optionOne"), t("workflow.default.optionTwo")], default: t("workflow.default.optionOne") };
  if (kind === "number") return { id, kind, label: t("workflow.default.numberLabel"), required: true, min: 0, max: 100, default: 1 };
  if (kind === "boolean") return { id, kind, label: t("workflow.default.booleanLabel"), default: true };
  if (kind === "image") return { id, kind, label: t("workflow.default.imageLabel"), required: false };
  return { id, kind, label: t(kind === "textarea" ? "workflow.default.textareaLabel" : "workflow.default.textLabel"), required: true };
}

export function WorkflowTemplateEditor({
  draft,
  busy,
  onChange,
  onSave,
  onDelete,
  onDuplicate,
}: {
  draft: WorkflowTemplate;
  busy?: boolean;
  onChange: (template: WorkflowTemplate) => void;
  onSave: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useI18n();
  const editable = draft.scope === "personal";
  const updateVariable = (index: number, variable: WorkflowVariable) => onChange({
    ...draft,
    variables: draft.variables.map((current, currentIndex) => currentIndex === index ? variable : current),
  });
  const updateStep = (index: number, step: WorkflowStep) => onChange({
    ...draft,
    steps: draft.steps.map((current, currentIndex) => currentIndex === index ? step : current),
  });
  const nextVariableId = () => {
    let index = draft.variables.length + 1;
    while (draft.variables.some((variable) => variable.id === `value_${index}`)) index += 1;
    return `value_${index}`;
  };
  const nextStepId = () => {
    let index = draft.steps.length + 1;
    while (draft.steps.some((step) => step.id === `step_${index}`)) index += 1;
    return `step_${index}`;
  };

  return (
    <section aria-label={t("workflow.templateEditor")} className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="mr-auto text-sm">{t("workflow.templateDesign")}</strong>
        <span className="rounded-full bg-[var(--ob-accent-soft)] px-2 py-1 text-xs text-[var(--ob-accent)]">
          {draft.scope === "public" ? t("workflow.publicReadOnly") : t("workflow.personalRevision", { revision: draft.revision })}
        </span>
        <button type="button" className="ob-btn-secondary inline-flex items-center gap-1 px-3 py-2 text-xs" disabled={busy}
          onClick={onDuplicate}><Copy size={14} />{t("workflow.duplicate")}</button>
        {editable ? (
          <>
            <button type="button" className="ob-btn-danger inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs" disabled={busy}
              onClick={onDelete}><Trash2 size={14} />{t("workflow.delete")}</button>
            <button type="button" className="ob-btn-primary inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs" disabled={busy}
              onClick={onSave}><Save size={14} />{t("workflow.save")}</button>
          </>
        ) : null}
      </div>

      <fieldset disabled={!editable || busy} className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="ob-label">{t("workflow.templateName")}</span>
          <input className="ob-field" value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
        </label>
        <label className="block">
          <span className="ob-label">{t("workflow.category")}</span>
          <input className="ob-field" value={draft.category} onChange={(event) => onChange({ ...draft, category: event.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="ob-label">{t("workflow.description")}</span>
          <textarea className="ob-field min-h-20 resize-y" value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })} />
        </label>
      </fieldset>

      <div className="rounded-xl border border-[var(--ob-line)] p-3">
        <div className="mb-3 flex items-center gap-2">
          <strong className="mr-auto text-sm">{t("workflow.variables")}</strong>
          {editable ? <button type="button" className="ob-icon-btn" title={t("workflow.addVariable")} disabled={busy || draft.variables.length >= 32}
            onClick={() => onChange({ ...draft, variables: [...draft.variables, variableForKind(nextVariableId(), "text", t)] })}><Plus size={15} /></button> : null}
        </div>
        <div className="space-y-3">
          {draft.variables.map((variable, index) => (
            <fieldset key={variable.id} disabled={!editable || busy} className="grid gap-2 rounded-lg bg-[var(--ob-canvas)] p-3 sm:grid-cols-[1fr_9rem_auto]">
              <label>
                <span className="ob-label">{t("workflow.variableLabel", { id: variable.id })}</span>
                <input className="ob-field" value={variable.label}
                  onChange={(event) => updateVariable(index, { ...variable, label: event.target.value })} />
              </label>
              <label>
                <span className="ob-label">{t("workflow.type")}</span>
                <select className="ob-field" value={variable.kind}
                  onChange={(event) => updateVariable(index, variableForKind(variable.id, event.target.value as WorkflowVariable["kind"], t))}>
                  <option value="text">{t("workflow.type.text")}</option><option value="textarea">{t("workflow.type.textarea")}</option><option value="select">{t("workflow.type.select")}</option>
                  <option value="number">{t("workflow.type.number")}</option><option value="boolean">{t("workflow.type.boolean")}</option><option value="image">{t("workflow.type.image")}</option>
                </select>
              </label>
              <button type="button" className="ob-icon-btn self-end" title={t("workflow.deleteVariable")}
                onClick={() => onChange({ ...draft, variables: draft.variables.filter((_, current) => current !== index) })}><Trash2 size={14} /></button>
              {variable.kind === "select" ? (
                <label className="sm:col-span-3"><span className="ob-label">{t("workflow.options")}</span>
                  <textarea className="ob-field min-h-16" value={variable.options.join("\n")}
                    onChange={(event) => updateVariable(index, { ...variable, options: event.target.value.split("\n").filter(Boolean) })} /></label>
              ) : null}
              {variable.kind === "number" ? (
                <div className="grid grid-cols-2 gap-2 sm:col-span-3">
                  <label><span className="ob-label">{t("workflow.min")}</span><input className="ob-field" type="number" value={variable.min}
                    onChange={(event) => updateVariable(index, { ...variable, min: Number(event.target.value) })} /></label>
                  <label><span className="ob-label">{t("workflow.max")}</span><input className="ob-field" type="number" value={variable.max}
                    onChange={(event) => updateVariable(index, { ...variable, max: Number(event.target.value) })} /></label>
                </div>
              ) : null}
            </fieldset>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--ob-line)] p-3">
        <div className="mb-3 flex items-center gap-2">
          <strong className="mr-auto text-sm">{t("workflow.imageSteps")}</strong>
          {editable ? <button type="button" className="ob-icon-btn" title={t("workflow.addStep")} disabled={busy || draft.steps.length >= 16}
            onClick={() => onChange({ ...draft, steps: [...draft.steps, {
              id: nextStepId(), title: t("workflow.default.step"), promptTemplate: "{{subject}}", providerId: "",
              parameters: { size: "1024x1024", quality: "auto", resolution: "", count: 1 }, references: [],
            }] })}><Plus size={15} /></button> : null}
        </div>
        <div className="space-y-3">
          {draft.steps.map((step, index) => {
            const imageReferences = new Set(step.references.filter((reference) => reference.source === "variable").map((reference) => reference.variableId));
            const stepReferences = new Set(step.references.filter((reference) => reference.source === "step").map((reference) => reference.stepId));
            return (
              <fieldset key={step.id} disabled={!editable || busy} className="grid gap-2 rounded-lg bg-[var(--ob-canvas)] p-3 sm:grid-cols-2">
                <label><span className="ob-label">{t("workflow.stepName", { id: step.id })}</span><input className="ob-field" value={step.title}
                  onChange={(event) => updateStep(index, { ...step, title: event.target.value })} /></label>
                <div className="flex items-end justify-end"><button type="button" className="ob-icon-btn" title={t("workflow.deleteStep")} disabled={draft.steps.length <= 1}
                  onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, current) => current !== index) })}><Trash2 size={14} /></button></div>
                <label className="sm:col-span-2"><span className="ob-label">{t("workflow.promptTemplate")}</span><textarea className="ob-field min-h-20 resize-y" value={step.promptTemplate}
                  onChange={(event) => updateStep(index, { ...step, promptTemplate: event.target.value })} /></label>
                <label><span className="ob-label">{t("workflow.provider")}</span><input className="ob-field" value={step.providerId}
                  onChange={(event) => updateStep(index, { ...step, providerId: event.target.value })} /></label>
                <label><span className="ob-label">{t("workflow.model")}</span><input className="ob-field" value={step.model ?? ""}
                  onChange={(event) => updateStep(index, { ...step, model: event.target.value })} /></label>
                <label><span className="ob-label">{t("workflow.size")}</span><input className="ob-field" value={step.parameters.size}
                  onChange={(event) => updateStep(index, { ...step, parameters: { ...step.parameters, size: event.target.value } })} /></label>
                <label><span className="ob-label">{t("workflow.resolution")}</span><input className="ob-field" placeholder={t("workflow.resolutionPlaceholder")} value={step.parameters.resolution ?? ""}
                  onChange={(event) => updateStep(index, { ...step, parameters: { ...step.parameters, resolution: event.target.value } })} /></label>
                <label><span className="ob-label">{t("workflow.count")}</span><input className="ob-field" type="number" min={1} max={100} value={step.parameters.count}
                  onChange={(event) => updateStep(index, { ...step, parameters: { ...step.parameters, count: Number(event.target.value) } })} /></label>
                <label><span className="ob-label">{t("workflow.imageVariables")}</span><select multiple className="ob-field min-h-20" value={[...imageReferences]}
                  onChange={(event) => {
                    const selected = [...event.currentTarget.selectedOptions].map((option) => option.value);
                    updateStep(index, { ...step, references: [
                      ...selected.map((variableId) => ({ source: "variable" as const, variableId })),
                      ...step.references.filter((reference) => reference.source === "step"),
                    ] });
                  }}>
                  {draft.variables.filter((variable) => variable.kind === "image").map((variable) => <option key={variable.id} value={variable.id}>{variable.label}</option>)}
                </select></label>
                <label><span className="ob-label">{t("workflow.stepDependencies")}</span><select multiple className="ob-field min-h-20" value={[...stepReferences]}
                  onChange={(event) => {
                    const selected = [...event.currentTarget.selectedOptions].map((option) => option.value);
                    updateStep(index, { ...step, references: [
                      ...step.references.filter((reference) => reference.source === "variable"),
                      ...selected.map((stepId) => ({ source: "step" as const, stepId, output: 0 as const })),
                    ] });
                  }}>
                  {draft.steps.filter((candidate) => candidate.id !== step.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
                </select></label>
              </fieldset>
            );
          })}
        </div>
      </div>
    </section>
  );
}
