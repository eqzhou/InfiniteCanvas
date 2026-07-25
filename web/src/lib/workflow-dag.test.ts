import { describe, expect, test } from "bun:test";

import { compileWorkflowPrompt, planWorkflowSteps, validateWorkflowValues } from "./workflow-dag";
import type { WorkflowTemplate } from "@/types/workflow";

const workflow: WorkflowTemplate = {
  schemaVersion: 1,
  id: "workflow_series",
  revision: 2,
  scope: "personal",
  title: "系列图",
  description: "",
  category: "测试",
  variables: [
    { id: "subject", kind: "text", label: "主体", required: true },
    { id: "style", kind: "select", label: "风格", required: true, options: ["电影", "插画"], default: "电影" },
    { id: "reference", kind: "image", label: "参考图", required: true },
    { id: "enabled", kind: "boolean", label: "启用", default: true },
  ],
  steps: [
    { id: "a", title: "A", promptTemplate: "{{subject}} · {{style}} · {{enabled}}", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [{ source: "variable", variableId: "reference" }] },
    { id: "b", title: "B", promptTemplate: "B {{subject}}", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [{ source: "step", stepId: "a", output: "all" }] },
    { id: "c", title: "C", promptTemplate: "C {{subject}}", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [] },
    { id: "d", title: "D", promptTemplate: "D {{subject}}", providerId: "channel", parameters: { size: "1024x1024", count: 1 }, references: [{ source: "step", stepId: "b", output: 0 }, { source: "step", stepId: "c", output: 0 }] },
  ],
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

describe("workflow compilation and DAG planning", () => {
  test("validates typed values and compiles exact scalar placeholders", () => {
    const values = validateWorkflowValues(workflow, {
      subject: "月球基地",
      style: "插画",
      reference: ["image:reference"],
      enabled: false,
    });
    expect(values).toEqual({
      subject: "月球基地",
      style: "插画",
      reference: ["image:reference"],
      enabled: false,
    });
    expect(compileWorkflowPrompt(workflow.steps[0]!, values)).toBe("月球基地 · 插画 · false");
    expect(() => validateWorkflowValues(workflow, { subject: "", style: "未知", reference: [] })).toThrow();
  });

  test("returns deterministic parallel levels and dependency order", () => {
    const plan = planWorkflowSteps(workflow);
    expect(plan.levels).toEqual([["a", "c"], ["b"], ["d"]]);
    expect(plan.order).toEqual(["a", "c", "b", "d"]);
    expect(plan.dependencies.get("d")).toEqual(["b", "c"]);
    expect(workflow.steps.map((step) => step.id)).toEqual(["a", "b", "c", "d"]);
  });
});
