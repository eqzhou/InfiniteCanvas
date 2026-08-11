import type { WorkflowTemplate, WorkflowValues } from "@/types/workflow";
import { useI18n } from "@/i18n/I18nProvider";

export function WorkflowVariableForm({
  template,
  values,
  imageFiles,
  disabled,
  onValuesChange,
  onImageFilesChange,
}: {
  template: WorkflowTemplate;
  values: Record<string, unknown>;
  imageFiles: Record<string, File[]>;
  disabled?: boolean;
  onValuesChange: (values: Record<string, unknown>) => void;
  onImageFilesChange: (variableId: string, files: File[]) => void;
}) {
  const { t } = useI18n();
  const setValue = (id: string, value: WorkflowValues[string]) =>
    onValuesChange({ ...values, [id]: value });

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-2 text-sm font-semibold text-[var(--ob-ink)]">{t("workflow.runVariables")}</legend>
      {template.variables.map((variable) => {
        const value = values[variable.id] ?? ("default" in variable ? variable.default : undefined);
        if (variable.kind === "textarea") {
          return (
            <label key={variable.id} className="block">
              <span className="ob-label">{variable.label}{variable.required ? " *" : ""}</span>
              <textarea className="ob-field min-h-24 resize-y" value={typeof value === "string" ? value : ""}
                onChange={(event) => setValue(variable.id, event.target.value)} />
            </label>
          );
        }
        if (variable.kind === "text") {
          return (
            <label key={variable.id} className="block">
              <span className="ob-label">{variable.label}{variable.required ? " *" : ""}</span>
              <input className="ob-field" value={typeof value === "string" ? value : ""}
                onChange={(event) => setValue(variable.id, event.target.value)} />
            </label>
          );
        }
        if (variable.kind === "select") {
          return (
            <label key={variable.id} className="block">
              <span className="ob-label">{variable.label}{variable.required ? " *" : ""}</span>
              <select className="ob-field" value={typeof value === "string" ? value : ""}
                onChange={(event) => setValue(variable.id, event.target.value)}>
                {!variable.required ? <option value="">{t("workflow.none")}</option> : null}
                {variable.options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          );
        }
        if (variable.kind === "number") {
          return (
            <label key={variable.id} className="block">
              <span className="ob-label">{variable.label}{variable.required ? " *" : ""}</span>
              <input className="ob-field" type="number" min={variable.min} max={variable.max}
                value={typeof value === "number" ? value : ""}
                onChange={(event) => setValue(variable.id, Number(event.target.value))} />
            </label>
          );
        }
        if (variable.kind === "boolean") {
          return (
            <label key={variable.id} className="flex items-center gap-2 text-sm text-[var(--ob-ink)]">
              <input type="checkbox" checked={typeof value === "boolean" ? value : variable.default}
                onChange={(event) => setValue(variable.id, event.target.checked)} />
              {variable.label}
            </label>
          );
        }
        return (
          <label key={variable.id} className="block">
            <span className="ob-label">{variable.label}{variable.required ? " *" : ""}</span>
            <input type="file" multiple accept="image/png,image/jpeg" className="mt-1 block w-full text-xs"
              onChange={(event) => onImageFilesChange(variable.id, Array.from(event.target.files ?? []).slice(0, 16))} />
            <span className="mt-1 block text-xs text-[var(--ob-muted)]">
              {t("workflow.imagesSelected", { count: imageFiles[variable.id]?.length ?? 0 })}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
