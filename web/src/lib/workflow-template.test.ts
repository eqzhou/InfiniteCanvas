import { describe, expect, test } from "bun:test";

import {
  createPersonalWorkflowTemplate,
  deletePersonalWorkflowTemplate,
  duplicatePersonalWorkflowTemplate,
  upsertPersonalWorkflowTemplate,
} from "./workflow-template";

describe("personal workflow template catalog", () => {
  test("creates, updates, duplicates, and deletes templates immutably", () => {
    const created = createPersonalWorkflowTemplate("角色工作流", "2026-07-24T00:00:00.000Z", "workflow_one");
    expect(created).toMatchObject({ id: "workflow_one", revision: 1, scope: "personal", title: "角色工作流" });
    expect(created.steps).toHaveLength(1);

    const catalog = [created];
    const updated = upsertPersonalWorkflowTemplate(catalog, {
      ...created,
      title: "角色工作流 v2",
      updatedAt: "2026-07-24T01:00:00.000Z",
    });
    expect(catalog[0]!.title).toBe("角色工作流");
    expect(updated[0]).toMatchObject({ title: "角色工作流 v2", revision: 2 });

    const duplicated = duplicatePersonalWorkflowTemplate(
      updated,
      created.id,
      "2026-07-24T02:00:00.000Z",
      "workflow_copy",
    );
    expect(duplicated).toHaveLength(2);
    expect(duplicated[1]).toMatchObject({ id: "workflow_copy", revision: 1, title: "角色工作流 v2 副本" });
    expect(duplicated[1]!.steps[0]).not.toBe(duplicated[0]!.steps[0]);

    expect(deletePersonalWorkflowTemplate(duplicated, "workflow_copy")).toEqual([updated[0]]);
  });

  test("never overwrites or deletes public templates", () => {
    const personal = createPersonalWorkflowTemplate("个人", "2026-07-24T00:00:00.000Z", "workflow_personal");
    const publicTemplate = { ...personal, id: "workflow_public", scope: "public" as const };
    expect(() => upsertPersonalWorkflowTemplate([publicTemplate], {
      ...publicTemplate,
      title: "非法修改",
    })).toThrow(/public/i);
    expect(() => deletePersonalWorkflowTemplate([publicTemplate], publicTemplate.id)).toThrow(/public/i);
  });
});
