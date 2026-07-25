import type {
  WorkflowStep,
  WorkflowTemplate,
  WorkflowValues,
  WorkflowVariable,
} from "@/types/workflow";

const STORAGE_KEY = /^(?:image|media):[^\s]{1,500}$/;
const PLACEHOLDER = /{{\s*([A-Za-z0-9][A-Za-z0-9:_-]{0,127})\s*}}/g;

function valueFor(variable: WorkflowVariable, value: unknown): string | number | boolean | string[] {
  const actual = value ?? ("default" in variable ? variable.default : undefined);
  if (variable.kind === "text" || variable.kind === "textarea") {
    if (typeof actual !== "string" || actual.length > 20_000 || (variable.required && !actual.trim())) {
      throw new Error(`${variable.label} is invalid`);
    }
    return actual;
  }
  if (variable.kind === "select") {
    if (typeof actual !== "string" || !variable.options.includes(actual)) throw new Error(`${variable.label} is invalid`);
    return actual;
  }
  if (variable.kind === "number") {
    if (typeof actual !== "number" || !Number.isFinite(actual) || actual < variable.min || actual > variable.max) {
      throw new Error(`${variable.label} is invalid`);
    }
    return actual;
  }
  if (variable.kind === "boolean") {
    if (typeof actual !== "boolean") throw new Error(`${variable.label} is invalid`);
    return actual;
  }
  if (!Array.isArray(actual) || actual.length > 16 || actual.some((key) => typeof key !== "string" || !STORAGE_KEY.test(key)) ||
      (variable.required && actual.length === 0)) {
    throw new Error(`${variable.label} is invalid`);
  }
  return [...actual];
}

export function validateWorkflowValues(template: WorkflowTemplate, input: Record<string, unknown>): WorkflowValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workflow values are invalid");
  const variableIds = new Set(template.variables.map((variable) => variable.id));
  const unknown = Object.keys(input).find((key) => !variableIds.has(key));
  if (unknown) throw new Error(`unknown workflow value: ${unknown}`);
  return Object.fromEntries(template.variables.map((variable) => [variable.id, valueFor(variable, input[variable.id])]));
}

export function compileWorkflowPrompt(step: WorkflowStep, values: WorkflowValues): string {
  const prompt = step.promptTemplate.replace(PLACEHOLDER, (_match, variableId: string) => {
    const value = values[variableId];
    if (value === undefined || Array.isArray(value)) throw new Error(`workflow placeholder ${variableId} is unresolved`);
    return String(value);
  });
  if (prompt.includes("{{") || prompt.includes("}}") || prompt.length > 100_000) {
    throw new Error("compiled workflow prompt is invalid or too large");
  }
  return prompt;
}

export function planWorkflowSteps(template: WorkflowTemplate): {
  order: string[];
  levels: string[][];
  dependencies: Map<string, string[]>;
} {
  const stepOrder = new Map(template.steps.map((step, index) => [step.id, index]));
  const dependencies = new Map(template.steps.map((step) => [step.id, [...new Set(step.references
    .filter((reference) => reference.source === "step")
    .map((reference) => reference.stepId))].sort((left, right) => stepOrder.get(left)! - stepOrder.get(right)!)]));
  const remaining = new Set(template.steps.map((step) => step.id));
  const completed = new Set<string>();
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = template.steps.map((step) => step.id).filter((id) =>
      remaining.has(id) && (dependencies.get(id) ?? []).every((dependency) => completed.has(dependency)));
    if (ready.length === 0) throw new Error("workflow contains a cycle");
    levels.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return { order: levels.flat(), levels, dependencies };
}
