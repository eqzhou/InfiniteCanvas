import type { GenerationJob } from "@/types/board";
import type {
  WorkflowRunParameters,
  WorkflowRunResult,
  WorkflowStepRunState,
  WorkflowTemplate,
} from "@/types/workflow";
import { parseWorkflowTemplate } from "@/lib/workflow-document";
import { validateWorkflowValues } from "@/lib/workflow-dag";
import { createWorkflowRunResult } from "@/lib/workflow-run";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STORAGE_KEY = /^(?:image|media):[^\s]{1,500}$/;
const STEP_STATUSES = new Set<WorkflowStepRunState["status"]>([
  "pending", "queued", "running", "succeeded", "failed", "cancelled", "skipped",
]);

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is unsafe`);
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error(`${label} contains unknown fields`);
}

function hash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul((left ^ code) >>> 0, 0x01000193) >>> 0;
    right = Math.imul((right ^ code) >>> 0, 0x85ebca6b) >>> 0;
  }
  return left.toString(16).padStart(8, "0") + right.toString(16).padStart(8, "0");
}

function parseStorageKeys(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((key) => typeof key !== "string" || !STORAGE_KEY.test(key))) {
    throw new Error(`${label} is invalid`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return [...value] as string[];
}

function parseStepState(value: unknown, label: string): WorkflowStepRunState {
  const input = plain(value, label);
  exactKeys(input, ["status", "childJobId", "storageKeys", "error"], label);
  if (!STEP_STATUSES.has(input.status as WorkflowStepRunState["status"])) throw new Error(`${label}.status is invalid`);
  const childJobId = input.childJobId;
  if (childJobId !== undefined && (typeof childJobId !== "string" || !ID.test(childJobId))) {
    throw new Error(`${label}.childJobId is invalid`);
  }
  const storageKeys = input.storageKeys === undefined ? undefined : parseStorageKeys(input.storageKeys, `${label}.storageKeys`, 8);
  const error = input.error;
  if (error !== undefined && (typeof error !== "string" || error.length > 10_000)) throw new Error(`${label}.error is invalid`);
  if (input.status === "queued" && !childJobId) throw new Error(`${label} queued state is missing child job id`);
  if (input.status === "succeeded" && !storageKeys?.length) throw new Error(`${label} succeeded state is missing media`);
  return {
    status: input.status as WorkflowStepRunState["status"],
    ...(childJobId === undefined ? {} : { childJobId }),
    ...(storageKeys === undefined ? {} : { storageKeys }),
    ...(error === undefined ? {} : { error }),
  };
}

export function parseWorkflowRunParameters(value: unknown): Omit<WorkflowRunParameters, "executor"> & { executor: "browser" | "workflow" } {
  const input = plain(value, "workflow parameters");
  exactKeys(input, ["executor", "requestHash", "templateId", "templateRevision", "templateSnapshot", "values"], "workflow parameters");
  if (input.executor !== "browser" && input.executor !== "workflow") throw new Error("workflow executor is invalid");
  if (typeof input.requestHash !== "string" || !/^[a-f0-9]{16,64}$/.test(input.requestHash)) {
    throw new Error("workflow requestHash is invalid");
  }
  const template = parseWorkflowTemplate(input.templateSnapshot);
  if (input.templateId !== template.id || input.templateRevision !== template.revision) {
    throw new Error("workflow template snapshot identity is invalid");
  }
  const values = validateWorkflowValues(template, plain(input.values, "workflow values"));
  return {
    executor: input.executor,
    requestHash: input.requestHash,
    templateId: template.id,
    templateRevision: template.revision,
    templateSnapshot: template,
    values,
  };
}

export function parseWorkflowRunResult(value: unknown, template: WorkflowTemplate): WorkflowRunResult {
  const input = plain(value, "workflow result");
  exactKeys(input, ["steps", "outputStorageKeys"], "workflow result");
  const rawSteps = plain(input.steps, "workflow result steps");
  const stepIds = new Set(template.steps.map((step) => step.id));
  if (Object.keys(rawSteps).length !== stepIds.size || Object.keys(rawSteps).some((id) => !stepIds.has(id))) {
    throw new Error("workflow result step identities are invalid");
  }
  const steps = Object.fromEntries(template.steps.map((step) => [
    step.id,
    parseStepState(rawSteps[step.id], `workflow result step ${step.id}`),
  ]));
  return {
    steps,
    outputStorageKeys: parseStorageKeys(input.outputStorageKeys, "workflow outputStorageKeys", 64),
  };
}

export function validateWorkflowGenerationJob(job: GenerationJob): GenerationJob {
  if (job.kind !== "workflow") throw new Error("generation job is not a workflow");
  const parameters = parseWorkflowRunParameters(job.parameters);
  const result = parseWorkflowRunResult(job.result, parameters.templateSnapshot);
  return structuredClone({ ...job, parameters, result });
}

export function buildWorkflowGenerationJob(input: {
  id: string;
  projectId?: string;
  template: WorkflowTemplate;
  values: Record<string, unknown>;
  executor: "browser" | "workflow";
  timestamp: string;
}): GenerationJob {
  if (!ID.test(input.id) || (input.projectId && !ID.test(input.projectId)) || Number.isNaN(Date.parse(input.timestamp))) {
    throw new Error("workflow generation identity is invalid");
  }
  const template = parseWorkflowTemplate(input.template);
  const values = validateWorkflowValues(template, input.values);
  const requestHash = hash(JSON.stringify({ template, values, projectId: input.projectId ?? "" }));
  return validateWorkflowGenerationJob({
    id: input.id,
    projectId: input.projectId,
    kind: "workflow",
    status: "queued",
    prompt: template.title,
    parameters: {
      executor: input.executor,
      requestHash,
      templateId: template.id,
      templateRevision: template.revision,
      templateSnapshot: template,
      values,
    },
    result: createWorkflowRunResult(template),
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  });
}

export function collectWorkflowJobStorageKeys(job: GenerationJob): Set<string> {
  const validated = validateWorkflowGenerationJob(job);
  const parameters = validated.parameters as unknown as ReturnType<typeof parseWorkflowRunParameters>;
  const result = validated.result as unknown as WorkflowRunResult;
  const keys = new Set<string>();
  for (const value of Object.values(parameters.values)) {
    if (Array.isArray(value)) for (const key of value) keys.add(key);
  }
  for (const state of Object.values(result.steps)) {
    for (const key of state.storageKeys ?? []) keys.add(key);
  }
  for (const key of result.outputStorageKeys) keys.add(key);
  return keys;
}
