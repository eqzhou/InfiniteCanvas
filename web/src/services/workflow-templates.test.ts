import { describe, expect, test } from "bun:test";

import {
  PUBLIC_WORKFLOW_TEMPLATES,
  mergeWorkflowTemplateCatalog,
  parsePersonalWorkflowTemplateDocument,
} from "./workflow-templates";
import { createPersonalWorkflowTemplate } from "@/lib/workflow-template";

describe("workflow template persistence", () => {
  test("ships valid read-only single and series public templates", () => {
    expect(PUBLIC_WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(2);
    expect(PUBLIC_WORKFLOW_TEMPLATES.every((template) => template.scope === "public")).toBe(true);
    expect(PUBLIC_WORKFLOW_TEMPLATES.some((template) => template.steps.length === 1)).toBe(true);
    expect(PUBLIC_WORKFLOW_TEMPLATES.some((template) => template.steps.length > 1)).toBe(true);
  });

  test("parses only bounded unique personal templates and merges public catalog first", () => {
    const personal = createPersonalWorkflowTemplate("我的模板", "2026-07-24T00:00:00.000Z", "workflow_mine");
    const parsed = parsePersonalWorkflowTemplateDocument({ version: 1, templates: [personal] });
    expect(parsed).toEqual([personal]);
    expect(parsed[0]).not.toBe(personal);
    expect(mergeWorkflowTemplateCatalog(parsed).map((template) => template.id)).toEqual([
      ...PUBLIC_WORKFLOW_TEMPLATES.map((template) => template.id),
      personal.id,
    ]);
    expect(() => parsePersonalWorkflowTemplateDocument({ version: 1, templates: [personal, personal] }))
      .toThrow(/duplicate/i);
    expect(() => parsePersonalWorkflowTemplateDocument({ version: 1, templates: [{ ...personal, scope: "public" }] }))
      .toThrow(/personal/i);
  });
});
