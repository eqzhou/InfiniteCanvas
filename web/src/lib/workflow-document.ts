import type {
  WorkflowStep,
  WorkflowStepReference,
  WorkflowTemplate,
  WorkflowVariable,
} from "@/types/workflow";

export const WORKFLOW_MAX_DOCUMENT_BYTES = 256 * 1024;
export const WORKFLOW_MAX_VARIABLES = 32;
export const WORKFLOW_MAX_STEPS = 16;
export const WORKFLOW_MAX_RESULTS = 1600;
export const WORKFLOW_MAX_REFERENCES_PER_STEP = 16;

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SIZE = /^(?:[1-9][0-9]{1,4}x[1-9][0-9]{1,4}|auto)$/;
const PLACEHOLDER = /{{\s*([^{}]+?)\s*}}/g;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} has an unsafe prototype`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const invalid = Object.keys(value).find((key) => !allow.has(key));
  if (invalid) throw new Error(`${label}.${invalid} is not supported`);
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string, allowEmpty = false): string {
  if (allowEmpty && value === "") return "";
  const result = text(value, label, 128);
  if (!ID.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function parseVariable(value: unknown, index: number): WorkflowVariable {
  const label = `variables[${index}]`;
  const input = object(value, label);
  const id = identifier(input.id, `${label}.id`);
  const kind = input.kind;
  const name = text(input.label, `${label}.label`, 200);
  if (kind === "text" || kind === "textarea") {
    exactKeys(input, ["id", "kind", "label", "required", "default"], label);
    const defaultValue = input.default === undefined ? undefined : text(input.default, `${label}.default`, 20_000, true);
    return { id, kind, label: name, required: boolean(input.required, `${label}.required`),
      ...(defaultValue === undefined ? {} : { default: defaultValue }) };
  }
  if (kind === "select") {
    exactKeys(input, ["id", "kind", "label", "required", "options", "default"], label);
    if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 64) {
      throw new Error(`${label}.options is invalid`);
    }
    const options = input.options.map((option, optionIndex) => text(option, `${label}.options[${optionIndex}]`, 500));
    if (new Set(options).size !== options.length) throw new Error(`${label}.options contains duplicates`);
    const defaultValue = input.default === undefined ? undefined : text(input.default, `${label}.default`, 500);
    if (defaultValue !== undefined && !options.includes(defaultValue)) throw new Error(`${label}.default is not an option`);
    return { id, kind, label: name, required: boolean(input.required, `${label}.required`), options,
      ...(defaultValue === undefined ? {} : { default: defaultValue }) };
  }
  if (kind === "number") {
    exactKeys(input, ["id", "kind", "label", "required", "min", "max", "default"], label);
    const min = finite(input.min, `${label}.min`);
    const max = finite(input.max, `${label}.max`);
    if (min > max || Math.abs(min) > 1e12 || Math.abs(max) > 1e12) throw new Error(`${label} number range is invalid`);
    const defaultValue = input.default === undefined ? undefined : finite(input.default, `${label}.default`);
    if (defaultValue !== undefined && (defaultValue < min || defaultValue > max)) throw new Error(`${label}.default is out of range`);
    return { id, kind, label: name, required: boolean(input.required, `${label}.required`), min, max,
      ...(defaultValue === undefined ? {} : { default: defaultValue }) };
  }
  if (kind === "boolean") {
    exactKeys(input, ["id", "kind", "label", "default"], label);
    return { id, kind, label: name, default: boolean(input.default, `${label}.default`) };
  }
  if (kind === "image") {
    exactKeys(input, ["id", "kind", "label", "required"], label);
    return { id, kind, label: name, required: boolean(input.required, `${label}.required`) };
  }
  throw new Error(`${label}.kind is invalid`);
}

function parseReference(value: unknown, stepIndex: number, referenceIndex: number): WorkflowStepReference {
  const label = `steps[${stepIndex}].references[${referenceIndex}]`;
  const input = object(value, label);
  if (input.source === "variable") {
    exactKeys(input, ["source", "variableId"], label);
    return { source: "variable", variableId: identifier(input.variableId, `${label}.variableId`) };
  }
  if (input.source === "step") {
    exactKeys(input, ["source", "stepId", "output"], label);
    const output = input.output;
    if (output !== "all" && (!Number.isSafeInteger(output) || (output as number) < 0 || (output as number) > 99)) {
      throw new Error(`${label}.output is invalid`);
    }
    return { source: "step", stepId: identifier(input.stepId, `${label}.stepId`), output: output as "all" | number };
  }
  throw new Error(`${label}.source is invalid`);
}

function parseStep(value: unknown, index: number): WorkflowStep {
  const label = `steps[${index}]`;
  const input = object(value, label);
  exactKeys(input, ["id", "title", "promptTemplate", "providerId", "model", "parameters", "references"], label);
  const parameters = object(input.parameters, `${label}.parameters`);
  exactKeys(parameters, ["size", "quality", "count", "transparentBackground"], `${label}.parameters`);
  const size = text(parameters.size, `${label}.parameters.size`, 50);
  if (!SIZE.test(size)) throw new Error(`${label}.parameters.size is invalid`);
  const count = finite(parameters.count, `${label}.parameters.count`);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error(`${label}.parameters.count must be 1-100`);
  if (!Array.isArray(input.references) || input.references.length > WORKFLOW_MAX_REFERENCES_PER_STEP) {
    throw new Error(`${label}.references exceeds limit`);
  }
  const model = input.model === undefined ? undefined : text(input.model, `${label}.model`, 500, true);
  const quality = parameters.quality === undefined ? undefined : text(parameters.quality, `${label}.parameters.quality`, 50, true);
  const transparentBackground = parameters.transparentBackground === undefined
    ? undefined
    : boolean(parameters.transparentBackground, `${label}.parameters.transparentBackground`);
  return {
    id: identifier(input.id, `${label}.id`),
    title: text(input.title, `${label}.title`, 200),
    promptTemplate: text(input.promptTemplate, `${label}.promptTemplate`, 20_000),
    providerId: identifier(input.providerId, `${label}.providerId`, true),
    ...(model === undefined ? {} : { model }),
    parameters: {
      size,
      count,
      ...(quality === undefined ? {} : { quality }),
      ...(transparentBackground === undefined ? {} : { transparentBackground }),
    },
    references: input.references.map((reference, referenceIndex) => parseReference(reference, index, referenceIndex)),
  };
}

function assertWorkflowGraph(variables: WorkflowVariable[], steps: WorkflowStep[]): void {
  const variableById = new Map(variables.map((variable) => [variable.id, variable]));
  const stepById = new Map(steps.map((step) => [step.id, step]));
  if (variableById.size !== variables.length) throw new Error("duplicate variable id");
  if (stepById.size !== steps.length) throw new Error("duplicate step id");
  const dependencies = new Map<string, string[]>();
  for (const step of steps) {
    const placeholders = [...step.promptTemplate.matchAll(PLACEHOLDER)];
    const consumed = placeholders.map((match) => match[0]).join("");
    const stripped = step.promptTemplate.replace(PLACEHOLDER, "");
    if (stripped.includes("{{") || stripped.includes("}}") || consumed.length > step.promptTemplate.length) {
      throw new Error(`step ${step.id} has an invalid placeholder`);
    }
    for (const match of placeholders) {
      const variableId = match[1]!;
      if (!ID.test(variableId) || !variableById.has(variableId) || variableById.get(variableId)?.kind === "image") {
        throw new Error(`step ${step.id} has an invalid placeholder`);
      }
    }
    const dependencyIds: string[] = [];
    const referenceKeys = new Set<string>();
    for (const reference of step.references) {
      const key = JSON.stringify(reference);
      if (referenceKeys.has(key)) throw new Error(`step ${step.id} has duplicate references`);
      referenceKeys.add(key);
      if (reference.source === "variable") {
        if (variableById.get(reference.variableId)?.kind !== "image") {
          throw new Error(`step ${step.id} references a missing image variable`);
        }
      } else {
        const source = stepById.get(reference.stepId);
        if (!source) throw new Error(`step ${step.id} references a missing step`);
        if (source.id === step.id) throw new Error("workflow contains a cycle");
        if (typeof reference.output === "number" && reference.output >= source.parameters.count) {
          throw new Error(`step ${step.id} references a missing step output`);
        }
        if (!dependencyIds.includes(source.id)) dependencyIds.push(source.id);
      }
    }
    dependencies.set(step.id, dependencyIds);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("workflow contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

export function parseWorkflowTemplate(value: unknown): WorkflowTemplate {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("workflow document size is invalid");
  }
  if (new TextEncoder().encode(serialized).byteLength > WORKFLOW_MAX_DOCUMENT_BYTES) {
    throw new Error("workflow document size exceeds limit");
  }
  const input = object(value, "workflow");
  exactKeys(input, ["schemaVersion", "id", "revision", "scope", "title", "description", "category", "variables", "steps", "createdAt", "updatedAt"], "workflow");
  if (input.schemaVersion !== 1) throw new Error("workflow schemaVersion is unsupported");
  const revision = finite(input.revision, "workflow.revision");
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000) throw new Error("workflow.revision is invalid");
  if (input.scope !== "public" && input.scope !== "personal") throw new Error("workflow.scope is invalid");
  if (!Array.isArray(input.variables) || input.variables.length > WORKFLOW_MAX_VARIABLES) {
    throw new Error("workflow variables exceed limit");
  }
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > WORKFLOW_MAX_STEPS) {
    throw new Error("workflow steps exceed limit");
  }
  const variables = input.variables.map(parseVariable);
  const steps = input.steps.map(parseStep);
  if (steps.reduce((total, step) => total + step.parameters.count, 0) > WORKFLOW_MAX_RESULTS) {
    throw new Error("workflow result count exceeds limit");
  }
  assertWorkflowGraph(variables, steps);
  const createdAt = text(input.createdAt, "workflow.createdAt", 100);
  const updatedAt = text(input.updatedAt, "workflow.updatedAt", 100);
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("workflow timestamps are invalid");
  }
  return structuredClone({
    schemaVersion: 1,
    id: identifier(input.id, "workflow.id"),
    revision,
    scope: input.scope,
    title: text(input.title, "workflow.title", 500),
    description: text(input.description, "workflow.description", 20_000, true),
    category: text(input.category, "workflow.category", 200, true),
    variables,
    steps,
    createdAt,
    updatedAt,
  });
}
