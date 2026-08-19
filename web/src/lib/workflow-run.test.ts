import { describe, expect, test } from "bun:test";

import {
  advanceWorkflowStep,
  createWorkflowRunResult,
  finalizeWorkflowRun,
  getReadyWorkflowStepIds,
  resolveWorkflowStepChildJobIds,
  workflowChildJobId,
  workflowStepChildJobIds,
} from "./workflow-run";
import type { WorkflowTemplate } from "@/types/workflow";

const template: WorkflowTemplate = {
  schemaVersion: 1,
  id: "workflow_diamond",
  revision: 1,
  scope: "personal",
  title: "Diamond",
  description: "",
  category: "test",
  variables: [],
  steps: [
    { id: "base", title: "Base", promptTemplate: "base", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [] },
    { id: "detail", title: "Detail", promptTemplate: "detail", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [{ source: "step", stepId: "base", output: 0 }] },
    { id: "alternate", title: "Alternate", promptTemplate: "alternate", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [{ source: "step", stepId: "base", output: 0 }] },
    { id: "final", title: "Final", promptTemplate: "final", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [{ source: "step", stepId: "detail", output: 0 }, { source: "step", stepId: "alternate", output: 0 }] },
  ],
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

describe("workflow run state machine", () => {
  test("advances a diamond DAG immutably and exposes only ready steps", () => {
    const initial = createWorkflowRunResult(template);
    expect(getReadyWorkflowStepIds(template, initial)).toEqual(["base"]);

    const queued = advanceWorkflowStep(template, initial, "base", {
      status: "queued",
      childJobId: workflowChildJobId("run_one", "base"),
    });
    const running = advanceWorkflowStep(template, queued, "base", { status: "running" });
    const succeeded = advanceWorkflowStep(template, running, "base", {
      status: "succeeded",
      storageKeys: ["image:base"],
    });
    expect(initial.steps.base?.status).toBe("pending");
    expect(getReadyWorkflowStepIds(template, succeeded)).toEqual(["detail", "alternate"]);
    expect(() => advanceWorkflowStep(template, succeeded, "base", { status: "running" })).toThrow(/transition/i);
  });

  test("blocks failed descendants while allowing independent completed work", () => {
    let result = createWorkflowRunResult(template);
    result = advanceWorkflowStep(template, result, "base", { status: "queued", childJobId: "job_base" });
    result = advanceWorkflowStep(template, result, "base", { status: "running" });
    result = advanceWorkflowStep(template, result, "base", { status: "succeeded", storageKeys: ["image:base"] });
    result = advanceWorkflowStep(template, result, "detail", { status: "queued", childJobId: "job_detail" });
    result = advanceWorkflowStep(template, result, "detail", { status: "running" });
    result = advanceWorkflowStep(template, result, "detail", { status: "failed", error: "safe failure" });
    result = advanceWorkflowStep(template, result, "alternate", { status: "queued", childJobId: "job_alt" });
    result = advanceWorkflowStep(template, result, "alternate", { status: "running" });
    result = advanceWorkflowStep(template, result, "alternate", { status: "succeeded", storageKeys: ["image:alt"] });

    const terminal = finalizeWorkflowRun(template, result);
    expect(terminal.status).toBe("failed");
    expect(terminal.result.steps.final?.status).toBe("skipped");
    expect(terminal.result.steps.alternate?.storageKeys).toEqual(["image:alt"]);
    expect(terminal.result.outputStorageKeys).toEqual([]);
  });

  test("uses bounded deterministic child ids", () => {
    const first = workflowChildJobId("run_" + "x".repeat(120), "step_" + "y".repeat(120));
    expect(first).toBe(workflowChildJobId("run_" + "x".repeat(120), "step_" + "y".repeat(120)));
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(workflowChildJobId("run_one", "base", 0)).toBe(workflowChildJobId("run_one", "base"));
    expect(workflowChildJobId("run_one", "base", 1)).not.toBe(workflowChildJobId("run_one", "base"));
  });

  test("expands a missing or n=1 child into per-image slots", () => {
    const slot0 = workflowChildJobId("run_one", "base");
    const slots = workflowStepChildJobIds("run_one", "base", 2);
    expect(resolveWorkflowStepChildJobIds("run_one", "base", 2, [], undefined)).toEqual(slots);
    expect(resolveWorkflowStepChildJobIds("run_one", "base", 2, [slot0], { found: false })).toEqual(slots);
    expect(resolveWorkflowStepChildJobIds("run_one", "base", 2, [slot0], { found: true, count: 1 })).toEqual(slots);
    expect(resolveWorkflowStepChildJobIds("run_one", "base", 2, [slot0], { found: true, count: 2 })).toEqual([slot0]);
    expect(resolveWorkflowStepChildJobIds("run_one", "base", 2, [], undefined, { found: true, count: 2 })).toEqual([slot0]);
    expect(resolveWorkflowStepChildJobIds("run_one", "base", 2, [], undefined, { found: false })).toEqual(slots);
  });
});
