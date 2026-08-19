import { afterEach, describe, expect, test } from "bun:test";

import {
  PUBLIC_WORKFLOW_TEMPLATES,
  duplicateWorkflowTemplate,
  listWorkflowTemplates,
  loadPersonalWorkflowTemplates,
  mergeWorkflowTemplateCatalog,
  parsePersonalWorkflowTemplateDocument,
  removePersonalWorkflowTemplate,
  replacePersonalWorkflowTemplates,
  savePersonalWorkflowTemplate,
} from "./workflow-templates";
import { createPersonalWorkflowTemplate } from "@/lib/workflow-template";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

  test("rejects malformed, oversized, and schema-expanded personal documents", () => {
    const cyclic: Record<string, unknown> = { version: 1, templates: [] };
    cyclic.self = cyclic;
    expect(() => parsePersonalWorkflowTemplateDocument(cyclic)).toThrow(/document is invalid/i);
    expect(() => parsePersonalWorkflowTemplateDocument({ version: 1, templates: [], extra: true }))
      .toThrow(/document is invalid/i);
    expect(() => parsePersonalWorkflowTemplateDocument({ version: 2, templates: [] }))
      .toThrow(/document is invalid/i);
    expect(() => parsePersonalWorkflowTemplateDocument({ version: 1, templates: "not-an-array" }))
      .toThrow(/document is invalid/i);
    expect(() => parsePersonalWorkflowTemplateDocument(null)).toThrow(/document is invalid/i);
    expect(() => parsePersonalWorkflowTemplateDocument({ version: 1, templates: [], padding: "x".repeat(8 * 1024 * 1024) }))
      .toThrow(/exceeds size limit/i);

    const personal = createPersonalWorkflowTemplate("我的模板", "2026-07-24T00:00:00.000Z", "workflow_mine");
    expect(() => mergeWorkflowTemplateCatalog([{ ...personal, id: PUBLIC_WORKFLOW_TEMPLATES[0]!.id }]))
      .toThrow(/conflicts/i);
  });

  test("loads, saves, duplicates, replaces, and removes through the authenticated API", async () => {
    const personal = createPersonalWorkflowTemplate("我的模板", "2026-07-24T00:00:00.000Z", "workflow_mine");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        if (url.endsWith("/workflow-templates")) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify([personal]), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    expect(await loadPersonalWorkflowTemplates()).toEqual([personal]);
    expect((await listWorkflowTemplates()).map((template) => template.id)).toEqual([
      ...PUBLIC_WORKFLOW_TEMPLATES.map((template) => template.id),
      personal.id,
    ]);
    const saved = await savePersonalWorkflowTemplate(personal);
    expect(saved).toEqual(personal);
    await removePersonalWorkflowTemplate(personal.id);
    await replacePersonalWorkflowTemplates([personal]);
    const duplicate = await duplicateWorkflowTemplate(personal.id);
    expect(duplicate.scope).toBe("personal");
    expect(duplicate.id).not.toBe(personal.id);
    expect(requests.some(({ init }) => init?.method === "DELETE")).toBe(true);
    await expect(savePersonalWorkflowTemplate({ ...personal, scope: "public" })).rejects.toThrow(/read-only/i);
  });

  test("surfaces server failures and malformed responses", async () => {
    const personal = createPersonalWorkflowTemplate("我的模板", "2026-07-24T00:00:00.000Z", "workflow_mine");
    globalThis.fetch = (async () => new Response("offline", { status: 503 })) as typeof fetch;
    await expect(loadPersonalWorkflowTemplates()).rejects.toThrow("HTTP 503");
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    await expect(loadPersonalWorkflowTemplates()).rejects.toThrow(/document is invalid/i);
    globalThis.fetch = (async () => new Response(JSON.stringify([{ ...personal, scope: "public" }]), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(loadPersonalWorkflowTemplates()).rejects.toThrow(/public/i);
    globalThis.fetch = (async () => new Response("offline", { status: 500 })) as typeof fetch;
    await expect(removePersonalWorkflowTemplate(personal.id)).rejects.toThrow("HTTP 500");
    await expect(replacePersonalWorkflowTemplates([personal])).rejects.toThrow("HTTP 500");
  });
});
