import { parseWorkflowTemplate } from "@/lib/workflow-document";
import type { WorkflowTemplate } from "@/types/workflow";

function personal(template: WorkflowTemplate): WorkflowTemplate {
  const parsed = parseWorkflowTemplate(template);
  if (parsed.scope !== "personal") throw new Error("public workflow templates are read-only");
  return parsed;
}

export function createPersonalWorkflowTemplate(
  title: string,
  timestamp: string,
  id: string,
): WorkflowTemplate {
  return personal({
    schemaVersion: 1,
    id,
    revision: 1,
    scope: "personal",
    title,
    description: "",
    category: "未分类",
    variables: [{ id: "subject", kind: "text", label: "主体描述", required: true }],
    steps: [{
      id: "image",
      title: "生成图片",
      promptTemplate: "{{subject}}",
      providerId: "",
      parameters: { size: "1024x1024", quality: "auto", count: 1 },
      references: [],
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function upsertPersonalWorkflowTemplate(
  templates: readonly WorkflowTemplate[],
  template: WorkflowTemplate,
): WorkflowTemplate[] {
  const next = personal(template);
  const index = templates.findIndex((candidate) => candidate.id === next.id);
  if (index < 0) return [...templates.map((candidate) => structuredClone(candidate)), { ...next, revision: 1 }];
  if (templates[index]!.scope === "public") throw new Error("public workflow templates are read-only");
  return templates.map((candidate, candidateIndex) => candidateIndex === index
    ? { ...next, revision: candidate.revision + 1 }
    : structuredClone(candidate));
}

export function duplicatePersonalWorkflowTemplate(
  templates: readonly WorkflowTemplate[],
  sourceId: string,
  timestamp: string,
  id: string,
): WorkflowTemplate[] {
  const source = templates.find((template) => template.id === sourceId);
  if (!source) throw new Error("workflow template not found");
  const copy = personal({
    ...structuredClone(source),
    id,
    revision: 1,
    scope: "personal",
    title: `${source.title} 副本`,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return [...templates.map((template) => structuredClone(template)), copy];
}

export function deletePersonalWorkflowTemplate(
  templates: readonly WorkflowTemplate[],
  id: string,
): WorkflowTemplate[] {
  const existing = templates.find((template) => template.id === id);
  if (existing?.scope === "public") throw new Error("public workflow templates are read-only");
  return templates.filter((template) => template.id !== id).map((template) => structuredClone(template));
}
