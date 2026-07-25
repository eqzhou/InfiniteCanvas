import { describe, expect, test } from "bun:test";

import {
  buildWorkflowGenerationJob,
  collectWorkflowJobStorageKeys,
  validateWorkflowGenerationJob,
} from "./workflow-job";
import { PUBLIC_WORKFLOW_TEMPLATES } from "@/services/workflow-templates";

describe("workflow generation job contract", () => {
  test("captures an immutable template/value snapshot and all nested media", () => {
    const template = PUBLIC_WORKFLOW_TEMPLATES[0]!;
    const job = buildWorkflowGenerationJob({
      id: "workflow_run_one",
      projectId: "project_one",
      template,
      values: {
        subject: "海边酒店",
        style: "商业摄影",
        reference: ["image:input"],
      },
      executor: "browser",
      timestamp: "2026-07-24T00:00:00.000Z",
    });
    const snapshot = job.parameters.templateSnapshot as typeof template;
    expect(job).toMatchObject({ kind: "workflow", status: "queued", id: "workflow_run_one" });
    expect(snapshot).toEqual(template);
    expect(snapshot).not.toBe(template);

    const complete = validateWorkflowGenerationJob({
      ...job,
      status: "succeeded",
      result: {
        steps: {
          poster: { status: "succeeded", childJobId: "wf_child", storageKeys: ["image:output"] },
        },
        outputStorageKeys: ["image:output"],
      },
    });
    expect([...collectWorkflowJobStorageKeys(complete)].sort()).toEqual(["image:input", "image:output"]);
  });

  test("rejects unknown step states, invalid values, and mutable executor markers", () => {
    const template = PUBLIC_WORKFLOW_TEMPLATES[0]!;
    const job = buildWorkflowGenerationJob({
      id: "workflow_run_two",
      template,
      values: { subject: "山谷", style: "电影感", reference: [] },
      executor: "workflow",
      timestamp: "2026-07-24T00:00:00.000Z",
    });
    expect(() => validateWorkflowGenerationJob({
      ...job,
      result: { steps: { missing: { status: "pending" } }, outputStorageKeys: [] },
    })).toThrow(/step/i);
    expect(() => validateWorkflowGenerationJob({
      ...job,
      parameters: { ...job.parameters, executor: "server" },
    })).toThrow(/executor/i);
    expect(() => buildWorkflowGenerationJob({
      id: "workflow_bad",
      template,
      values: { subject: "", style: "bad", reference: [] },
      executor: "browser",
      timestamp: "2026-07-24T00:00:00.000Z",
    })).toThrow();
  });
});
