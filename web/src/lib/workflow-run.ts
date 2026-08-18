import type {
  WorkflowRunResult,
  WorkflowStepRunState,
  WorkflowTemplate,
} from "@/types/workflow";

const TERMINAL = new Set<WorkflowStepRunState["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

const TRANSITIONS: Record<WorkflowStepRunState["status"], ReadonlySet<WorkflowStepRunState["status"]>> = {
  pending: new Set(["queued", "cancelled", "skipped"]),
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  skipped: new Set(),
};

function stepDependencies(template: WorkflowTemplate, stepId: string): string[] {
  const step = template.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("workflow step not found");
  return [...new Set(step.references
    .filter((reference) => reference.source === "step")
    .map((reference) => reference.stepId))];
}

export function createWorkflowRunResult(template: WorkflowTemplate): WorkflowRunResult {
  return {
    steps: Object.fromEntries(template.steps.map((step) => [step.id, { status: "pending" }])),
    outputStorageKeys: [],
  };
}

export function getReadyWorkflowStepIds(template: WorkflowTemplate, result: WorkflowRunResult): string[] {
  return template.steps.filter((step) => result.steps[step.id]?.status === "pending" &&
    stepDependencies(template, step.id).every((dependency) => result.steps[dependency]?.status === "succeeded"))
    .map((step) => step.id);
}

function validateNextStepState(previous: WorkflowStepRunState, next: WorkflowStepRunState): void {
  if (!TRANSITIONS[previous.status].has(next.status)) throw new Error("invalid workflow step transition");
  if (next.status === "queued" && (!next.childJobId || next.childJobId.length > 128)) {
    throw new Error("queued workflow step requires a child job id");
  }
  if (next.status === "succeeded" && (!next.storageKeys?.length || next.storageKeys.length > 100 ||
      next.storageKeys.some((key) => !/^(?:image|media):[^\s]{1,500}$/.test(key)))) {
    throw new Error("succeeded workflow step requires bounded result media");
  }
  if ((next.error?.length ?? 0) > 10_000) throw new Error("workflow step error is too large");
}

export function advanceWorkflowStep(
  template: WorkflowTemplate,
  result: WorkflowRunResult,
  stepId: string,
  patch: Omit<WorkflowStepRunState, "status"> & { status: WorkflowStepRunState["status"] },
): WorkflowRunResult {
  if (!template.steps.some((step) => step.id === stepId)) throw new Error("workflow step not found");
  const previous = result.steps[stepId];
  if (!previous) throw new Error("workflow step state not found");
  const next = { ...previous, ...structuredClone(patch) };
  validateNextStepState(previous, next);
  return {
    ...structuredClone(result),
    steps: { ...structuredClone(result.steps), [stepId]: next },
  };
}

export function finalizeWorkflowRun(template: WorkflowTemplate, value: WorkflowRunResult): {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result: WorkflowRunResult;
} {
  let result = structuredClone(value);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of template.steps) {
      if (result.steps[step.id]?.status !== "pending") continue;
      const dependencies = stepDependencies(template, step.id);
      if (dependencies.some((dependency) => {
        const status = result.steps[dependency]?.status;
        return status === "failed" || status === "cancelled" || status === "skipped";
      })) {
        result = advanceWorkflowStep(template, result, step.id, { status: "skipped" });
        changed = true;
      }
    }
  }

  const states = template.steps.map((step) => result.steps[step.id]!);
  let status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  if (states.some((state) => state.status === "failed")) status = "failed";
  else if (states.every((state) => state.status === "cancelled" || state.status === "skipped")) status = "cancelled";
  else if (states.every((state) => TERMINAL.has(state.status))) status = "succeeded";
  else if (states.some((state) => state.status === "running" || state.status === "queued" || state.status === "succeeded")) status = "running";
  else status = "queued";

  const dependedOn = new Set(template.steps.flatMap((step) => stepDependencies(template, step.id)));
  result.outputStorageKeys = status === "succeeded" ? template.steps
    .filter((step) => !dependedOn.has(step.id))
    .flatMap((step) => result.steps[step.id]?.storageKeys ?? []) : [];
  return { status, result };
}

function fnv32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function workflowChildJobId(runId: string, stepId: string): string {
  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const safeStep = stepId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const identity = `${runId}\u0000${stepId}`;
  return `wf_${safeRun}_${safeStep}_${fnv32(identity, 0x811c9dc5)}${fnv32(identity, 0x9e3779b9)}`.slice(0, 128);
}
