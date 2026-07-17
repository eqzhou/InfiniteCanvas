import type { AiTemplateConfig } from "@/types/board";
import { validateJsonObject } from "@/lib/bounded-json";

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,15}$/;
const PLACEHOLDER = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/;
const ALLOWED_PLACEHOLDERS = new Set([
  "prompt",
  "model",
  "size",
  "quality",
  "count",
  "duration",
  "ratio",
  "resolution",
  "transparentBackground",
  "referenceImages",
  "referenceVideos",
  "referenceAudios",
]);

export function validateProviderTemplate(template: AiTemplateConfig): void {
  if (template.method !== "POST" && template.method !== "PUT") {
    throw new Error("template method must be POST or PUT");
  }
  if (
    !template.path.startsWith("/") || template.path.startsWith("//") ||
    template.path.includes("?") || template.path.includes("#") ||
    template.path.includes("\\") || template.path.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("template path must be a safe relative path without query parameters");
  }
  if (template.auth !== "bearer" && template.auth !== "x-api-key") {
    throw new Error("template auth is unsupported");
  }
  validateJsonObject(template.request, {
    label: "template request",
    maxBytes: 128 * 1024,
    maxDepth: 20,
    maxEntries: 10_000,
  });
  for (const [label, path] of [
    ["responsePath", template.responsePath],
    ["taskIdPath", template.taskIdPath],
    ["statusPath", template.statusPath],
    ["resultPath", template.resultPath],
  ] as const) {
    if (path !== undefined && !FIELD_PATH.test(path)) {
      throw new Error(`template ${label} must be a simple field path`);
    }
  }
}

export function compileProviderTemplate(
  template: AiTemplateConfig,
  values: Record<string, unknown>,
): Record<string, unknown> {
  validateProviderTemplate(template);
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      const match = PLACEHOLDER.exec(value);
      if (match) {
        const key = match[1]!;
        if (!ALLOWED_PLACEHOLDERS.has(key)) throw new Error(`unsupported template placeholder: ${key}`);
        return structuredClone(values[key] ?? null);
      }
      if (value.includes("{{") || value.includes("}}")) {
        throw new Error("template placeholder must occupy the complete JSON string");
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  return replace(template.request) as Record<string, unknown>;
}

export function readTemplatePath(value: unknown, path: string): unknown {
  if (!FIELD_PATH.test(path)) throw new Error("template responsePath must be a simple field path");
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      throw new Error(`template response field is missing: ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolveTemplateEndpoint(baseUrl: string, template: AiTemplateConfig): string {
  validateProviderTemplate(template);
  const url = new URL(baseUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("template base URL must use HTTPS (loopback HTTP is allowed)");
  }
  if (url.username || url.password) throw new Error("template base URL must not contain credentials");
  if (url.search || url.hash) throw new Error("template base URL must not contain query parameters or fragments");
  return `${url.toString().replace(/\/+$/, "")}${template.path}`;
}
