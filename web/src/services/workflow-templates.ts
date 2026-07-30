import { parseWorkflowTemplate } from "@/lib/workflow-document";
import {
  duplicatePersonalWorkflowTemplate,
} from "@/lib/workflow-template";
import { nowIso, uid } from "@/lib/id";
import { authFetch } from "@/services/auth-session";
import type { WorkflowTemplate } from "@/types/workflow";

const MAX_PERSONAL_TEMPLATES = 1_000;
const DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

const PUBLIC_TIMESTAMP = "2026-07-24T00:00:00.000Z";

export const PUBLIC_WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = Object.freeze([
  parseWorkflowTemplate({
    schemaVersion: 1,
    id: "public_single_poster",
    revision: 1,
    scope: "public",
    title: "单图主视觉",
    description: "根据主体、风格和可选参考图生成一张主视觉。",
    category: "单图",
    variables: [
      { id: "subject", kind: "textarea", label: "主体描述", required: true },
      { id: "style", kind: "select", label: "视觉风格", required: true, options: ["电影感", "商业摄影", "插画"], default: "电影感" },
      { id: "reference", kind: "image", label: "参考图", required: false },
    ],
    steps: [{
      id: "poster",
      title: "生成主视觉",
      promptTemplate: "{{subject}}，{{style}}，构图完整、主体清晰",
      providerId: "",
      parameters: { size: "1024x1024", quality: "auto", count: 1 },
      references: [{ source: "variable", variableId: "reference" }],
    }],
    createdAt: PUBLIC_TIMESTAMP,
    updatedAt: PUBLIC_TIMESTAMP,
  }),
  parseWorkflowTemplate({
    schemaVersion: 1,
    id: "public_character_series",
    revision: 1,
    scope: "public",
    title: "角色系列图",
    description: "先生成角色主图，再并行生成细节图和场景图。",
    category: "系列图",
    variables: [
      { id: "character", kind: "textarea", label: "角色描述", required: true },
      { id: "reference", kind: "image", label: "角色参考图", required: false },
    ],
    steps: [
      {
        id: "base",
        title: "角色主图",
        promptTemplate: "{{character}}，全身角色设定图，纯净背景",
        providerId: "",
        parameters: { size: "1024x1024", quality: "auto", count: 1 },
        references: [{ source: "variable", variableId: "reference" }],
      },
      {
        id: "detail",
        title: "角色细节",
        promptTemplate: "{{character}}，服装与面部细节特写，保持角色一致",
        providerId: "",
        parameters: { size: "1024x1024", quality: "auto", count: 2 },
        references: [{ source: "step", stepId: "base", output: 0 }],
      },
      {
        id: "scene",
        title: "角色场景",
        promptTemplate: "{{character}}，置于有叙事感的环境中，保持角色一致",
        providerId: "",
        parameters: { size: "1024x1024", quality: "auto", count: 2 },
        references: [{ source: "step", stepId: "base", output: 0 }],
      },
    ],
    createdAt: PUBLIC_TIMESTAMP,
    updatedAt: PUBLIC_TIMESTAMP,
  }),
]);

export function parsePersonalWorkflowTemplateDocument(value: unknown): WorkflowTemplate[] {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("workflow template document is invalid");
  }
  if (new TextEncoder().encode(serialized).byteLength > DOCUMENT_MAX_BYTES) {
    throw new Error("workflow template document exceeds size limit");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow template document is invalid");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.templates) || input.templates.length > MAX_PERSONAL_TEMPLATES ||
      Object.keys(input).some((key) => key !== "version" && key !== "templates")) {
    throw new Error("workflow template document is invalid");
  }
  const templates = input.templates.map(parseWorkflowTemplate);
  if (templates.some((template) => template.scope !== "personal")) {
    throw new Error("personal workflow storage cannot contain public templates");
  }
  if (new Set(templates.map((template) => template.id)).size !== templates.length) {
    throw new Error("duplicate workflow template id");
  }
  return templates;
}

export function mergeWorkflowTemplateCatalog(personal: readonly WorkflowTemplate[]): WorkflowTemplate[] {
  const publicIds = new Set(PUBLIC_WORKFLOW_TEMPLATES.map((template) => template.id));
  if (personal.some((template) => publicIds.has(template.id))) throw new Error("personal workflow id conflicts with a public template");
  return [...PUBLIC_WORKFLOW_TEMPLATES.map((template) => structuredClone(template)), ...personal.map(parseWorkflowTemplate)];
}

async function serverJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(path, init);
  if (!response.ok) throw new Error(`Workflow templates failed: HTTP ${response.status}`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function loadPersonalWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const templates = await serverJSON<unknown[]>("workflow-templates");
  return parsePersonalWorkflowTemplateDocument({ version: 1, templates });
}

export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  return mergeWorkflowTemplateCatalog(await loadPersonalWorkflowTemplates());
}

export async function savePersonalWorkflowTemplate(template: WorkflowTemplate): Promise<WorkflowTemplate> {
  const parsed = parseWorkflowTemplate(template);
  if (parsed.scope !== "personal") throw new Error("public workflow templates are read-only");
  return parseWorkflowTemplate(await serverJSON<unknown>(
    `workflow-templates/${encodeURIComponent(parsed.id)}`,
    { method: "PUT", body: JSON.stringify(parsed) },
  ));
}

export async function duplicateWorkflowTemplate(sourceId: string): Promise<WorkflowTemplate> {
  const catalog = await listWorkflowTemplates();
  const id = uid("workflow");
  const next = duplicatePersonalWorkflowTemplate(catalog, sourceId, nowIso(), id);
  const copy = next.find((template) => template.id === id)!;
  return savePersonalWorkflowTemplate(copy);
}

export async function removePersonalWorkflowTemplate(id: string): Promise<void> {
  await serverJSON<void>(`workflow-templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function replacePersonalWorkflowTemplates(templates: WorkflowTemplate[]): Promise<void> {
  const parsed = parsePersonalWorkflowTemplateDocument({ version: 1, templates });
  await serverJSON<void>("workflow-templates", { method: "PUT", body: JSON.stringify(parsed) });
}
