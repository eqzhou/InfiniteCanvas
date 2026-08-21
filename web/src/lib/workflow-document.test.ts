import { describe, expect, test } from "bun:test";

import { parseWorkflowTemplate } from "./workflow-document";

const template = () => ({
  schemaVersion: 1,
  id: "workflow_portrait",
  revision: 1,
  scope: "personal",
  title: "角色系列图",
  description: "生成统一角色的多张系列图",
  category: "角色",
  variables: [
    { id: "subject", kind: "text", label: "角色描述", required: true, default: "宇航员" },
    { id: "reference", kind: "image", label: "参考图", required: false },
    { id: "count", kind: "number", label: "张数", required: true, min: 1, max: 4, default: 2 },
  ],
  steps: [
    {
      id: "hero",
      title: "主视觉",
      promptTemplate: "{{subject}} 的电影主视觉",
      providerId: "channel_main",
      model: "image-model",
      parameters: { size: "1024x1024", quality: "high", resolution: "2K", count: 1 },
      references: [{ source: "variable", variableId: "reference" }],
    },
    {
      id: "detail",
      title: "细节图",
      promptTemplate: "保持 {{subject}} 一致，生成服装细节",
      providerId: "channel_main",
      parameters: { size: "1024x1024", count: 1 },
      references: [{ source: "step", stepId: "hero", output: 0 }],
    },
  ],
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
});

describe("workflow template document", () => {
  test("accepts a bounded v1 personal series template without mutating it", () => {
    const input = template();
    const parsed = parseWorkflowTemplate(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.steps[0]).not.toBe(input.steps[0]);
  });

  test("migrates legacy resolution values stored in workflow quality", () => {
    const input = template();
    input.steps[0]!.parameters = { size: "1024x1024", quality: "2K", count: 1 };
    const parsed = parseWorkflowTemplate(input);
    expect(parsed.steps[0]?.parameters).toMatchObject({ quality: "auto", resolution: "2K" });
  });

  test("rejects duplicate ids, dangling references, cycles, and unsafe placeholders", () => {
    const duplicate = template();
    duplicate.steps[1]!.id = duplicate.steps[0]!.id;
    expect(() => parseWorkflowTemplate(duplicate)).toThrow(/duplicate step/i);

    const dangling = template();
    dangling.steps[1]!.references = [{ source: "step", stepId: "missing", output: 0 }];
    expect(() => parseWorkflowTemplate(dangling)).toThrow(/missing step/i);

    const cycle = template();
    cycle.steps[0]!.references = [{ source: "step", stepId: "detail", output: 0 }];
    expect(() => parseWorkflowTemplate(cycle)).toThrow(/cycle/i);

    const expression = template();
    expression.steps[0]!.promptTemplate = "{{subject.constructor}}";
    expect(() => parseWorkflowTemplate(expression)).toThrow(/placeholder/i);
  });

  test("rejects excessive variables, steps, options, output counts, and document size", () => {
    const tooManyVariables = template();
    tooManyVariables.variables = Array.from({ length: 33 }, (_, index) => ({
      id: `value_${index}`,
      kind: "text",
      label: `Value ${index}`,
      required: false,
    }));
    expect(() => parseWorkflowTemplate(tooManyVariables)).toThrow(/variables/i);

    const tooManySteps = template();
    tooManySteps.steps = Array.from({ length: 17 }, (_, index) => ({
      ...tooManySteps.steps[0]!,
      id: `step_${index}`,
      references: [],
    }));
    expect(() => parseWorkflowTemplate(tooManySteps)).toThrow(/steps/i);

    const tooManyResults = template();
    tooManyResults.steps[0]!.parameters.count = 101;
    expect(() => parseWorkflowTemplate(tooManyResults)).toThrow(/count/i);

    const oversized = template();
    oversized.description = "x".repeat(300_000);
    expect(() => parseWorkflowTemplate(oversized)).toThrow(/size/i);
  });
});
