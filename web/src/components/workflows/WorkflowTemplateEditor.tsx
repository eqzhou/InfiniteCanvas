import { Copy, Plus, Save, Trash2 } from "lucide-react";

import type { WorkflowStep, WorkflowTemplate, WorkflowVariable } from "@/types/workflow";

function variableForKind(id: string, kind: WorkflowVariable["kind"]): WorkflowVariable {
  if (kind === "select") return { id, kind, label: "选择变量", required: true, options: ["选项一", "选项二"], default: "选项一" };
  if (kind === "number") return { id, kind, label: "数字变量", required: true, min: 0, max: 100, default: 1 };
  if (kind === "boolean") return { id, kind, label: "开关变量", default: true };
  if (kind === "image") return { id, kind, label: "参考图", required: false };
  return { id, kind, label: kind === "textarea" ? "长文本变量" : "文本变量", required: true };
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
    <section aria-label="工作流模板编辑器" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="mr-auto text-sm">模板设计</strong>
        <span className="rounded-full bg-[var(--ob-accent-soft)] px-2 py-1 text-xs text-[var(--ob-accent)]">
          {draft.scope === "public" ? "公开只读" : `个人 · r${draft.revision}`}
        </span>
        <button type="button" className="ob-btn-secondary inline-flex items-center gap-1 px-3 py-2 text-xs" disabled={busy}
          onClick={onDuplicate}><Copy size={14} />复制</button>
        {editable ? (
          <>
            <button type="button" className="ob-btn-danger inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs" disabled={busy}
              onClick={onDelete}><Trash2 size={14} />删除</button>
            <button type="button" className="ob-btn-primary inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs" disabled={busy}
              onClick={onSave}><Save size={14} />保存</button>
          </>
        ) : null}
      </div>

      <fieldset disabled={!editable || busy} className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="ob-label">模板名称</span>
          <input className="ob-field" value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
        </label>
        <label className="block">
          <span className="ob-label">分类</span>
          <input className="ob-field" value={draft.category} onChange={(event) => onChange({ ...draft, category: event.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="ob-label">说明</span>
          <textarea className="ob-field min-h-20 resize-y" value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })} />
        </label>
      </fieldset>

      <div className="rounded-xl border border-[var(--ob-line)] p-3">
        <div className="mb-3 flex items-center gap-2">
          <strong className="mr-auto text-sm">变量</strong>
          {editable ? <button type="button" className="ob-icon-btn" title="添加变量" disabled={busy || draft.variables.length >= 32}
            onClick={() => onChange({ ...draft, variables: [...draft.variables, variableForKind(nextVariableId(), "text")] })}><Plus size={15} /></button> : null}
        </div>
        <div className="space-y-3">
          {draft.variables.map((variable, index) => (
            <fieldset key={variable.id} disabled={!editable || busy} className="grid gap-2 rounded-lg bg-[var(--ob-canvas)] p-3 sm:grid-cols-[1fr_9rem_auto]">
              <label>
                <span className="ob-label">标签 · {variable.id}</span>
                <input className="ob-field" value={variable.label}
                  onChange={(event) => updateVariable(index, { ...variable, label: event.target.value })} />
              </label>
              <label>
                <span className="ob-label">类型</span>
                <select className="ob-field" value={variable.kind}
                  onChange={(event) => updateVariable(index, variableForKind(variable.id, event.target.value as WorkflowVariable["kind"]))}>
                  <option value="text">文本</option><option value="textarea">长文本</option><option value="select">选择</option>
                  <option value="number">数字</option><option value="boolean">开关</option><option value="image">图片</option>
                </select>
              </label>
              <button type="button" className="ob-icon-btn self-end" title="删除变量"
                onClick={() => onChange({ ...draft, variables: draft.variables.filter((_, current) => current !== index) })}><Trash2 size={14} /></button>
              {variable.kind === "select" ? (
                <label className="sm:col-span-3"><span className="ob-label">选项（每行一个）</span>
                  <textarea className="ob-field min-h-16" value={variable.options.join("\n")}
                    onChange={(event) => updateVariable(index, { ...variable, options: event.target.value.split("\n").filter(Boolean) })} /></label>
              ) : null}
              {variable.kind === "number" ? (
                <div className="grid grid-cols-2 gap-2 sm:col-span-3">
                  <label><span className="ob-label">最小值</span><input className="ob-field" type="number" value={variable.min}
                    onChange={(event) => updateVariable(index, { ...variable, min: Number(event.target.value) })} /></label>
                  <label><span className="ob-label">最大值</span><input className="ob-field" type="number" value={variable.max}
                    onChange={(event) => updateVariable(index, { ...variable, max: Number(event.target.value) })} /></label>
                </div>
              ) : null}
            </fieldset>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--ob-line)] p-3">
        <div className="mb-3 flex items-center gap-2">
          <strong className="mr-auto text-sm">图片步骤</strong>
          {editable ? <button type="button" className="ob-icon-btn" title="添加步骤" disabled={busy || draft.steps.length >= 16}
            onClick={() => onChange({ ...draft, steps: [...draft.steps, {
              id: nextStepId(), title: "新步骤", promptTemplate: "{{subject}}", providerId: "",
              parameters: { size: "1024x1024", quality: "auto", count: 1 }, references: [],
            }] })}><Plus size={15} /></button> : null}
        </div>
        <div className="space-y-3">
          {draft.steps.map((step, index) => {
            const imageReferences = new Set(step.references.filter((reference) => reference.source === "variable").map((reference) => reference.variableId));
            const stepReferences = new Set(step.references.filter((reference) => reference.source === "step").map((reference) => reference.stepId));
            return (
              <fieldset key={step.id} disabled={!editable || busy} className="grid gap-2 rounded-lg bg-[var(--ob-canvas)] p-3 sm:grid-cols-2">
                <label><span className="ob-label">步骤名称 · {step.id}</span><input className="ob-field" value={step.title}
                  onChange={(event) => updateStep(index, { ...step, title: event.target.value })} /></label>
                <div className="flex items-end justify-end"><button type="button" className="ob-icon-btn" title="删除步骤" disabled={draft.steps.length <= 1}
                  onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, current) => current !== index) })}><Trash2 size={14} /></button></div>
                <label className="sm:col-span-2"><span className="ob-label">提示词模板</span><textarea className="ob-field min-h-20 resize-y" value={step.promptTemplate}
                  onChange={(event) => updateStep(index, { ...step, promptTemplate: event.target.value })} /></label>
                <label><span className="ob-label">渠道 ID（留空使用当前渠道）</span><input className="ob-field" value={step.providerId}
                  onChange={(event) => updateStep(index, { ...step, providerId: event.target.value })} /></label>
                <label><span className="ob-label">模型（留空使用渠道默认）</span><input className="ob-field" value={step.model ?? ""}
                  onChange={(event) => updateStep(index, { ...step, model: event.target.value })} /></label>
                <label><span className="ob-label">尺寸</span><input className="ob-field" value={step.parameters.size}
                  onChange={(event) => updateStep(index, { ...step, parameters: { ...step.parameters, size: event.target.value } })} /></label>
                <label><span className="ob-label">数量</span><input className="ob-field" type="number" min={1} max={8} value={step.parameters.count}
                  onChange={(event) => updateStep(index, { ...step, parameters: { ...step.parameters, count: Number(event.target.value) } })} /></label>
                <label><span className="ob-label">图片变量（可多选）</span><select multiple className="ob-field min-h-20" value={[...imageReferences]}
                  onChange={(event) => {
                    const selected = [...event.currentTarget.selectedOptions].map((option) => option.value);
                    updateStep(index, { ...step, references: [
                      ...selected.map((variableId) => ({ source: "variable" as const, variableId })),
                      ...step.references.filter((reference) => reference.source === "step"),
                    ] });
                  }}>
                  {draft.variables.filter((variable) => variable.kind === "image").map((variable) => <option key={variable.id} value={variable.id}>{variable.label}</option>)}
                </select></label>
                <label><span className="ob-label">依赖步骤（可多选）</span><select multiple className="ob-field min-h-20" value={[...stepReferences]}
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
