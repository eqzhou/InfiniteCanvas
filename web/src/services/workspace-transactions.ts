import type { BoardProject } from "@/types/board";
import type { FilmDocument } from "@/types/film";
import type { WorkspaceSnapshot } from "@/lib/workspace-bundle";
import type { FilmRestoreMedia } from "@/services/film-client";
import type { WorkflowTemplate } from "@/types/workflow";
import { authFetch } from "@/services/auth-session";

export type FilmRestoreTransactionInput = {
  revision: number;
  document: FilmDocument;
  media: FilmRestoreMedia[];
};

export type ProjectImportTransactionInput = {
  project: BoardProject;
  film?: FilmRestoreTransactionInput;
};

export type ProjectImportTransactionResult = {
  project: BoardProject;
  film?: FilmDocument;
  migratedStorageKeys: string[];
};

export type CompleteWorkspaceTransactionInput = {
  snapshot: Omit<WorkspaceSnapshot, "films">;
  films: FilmRestoreTransactionInput[];
};

export type WorkspaceRestoreReceipt = {
  version: string;
  restoreToken: string;
  migratedStorageKeys: string[];
};

type WorkflowTemplatesTransactionPayload = {
  version: 1;
  templates: WorkflowTemplate[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storageKeys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Transaction migratedStorageKeys are invalid");
  }
  return [...new Set(value)];
}

async function jsonData(response: Response, label: string): Promise<Record<string, unknown>> {
  const payload = record(await response.json().catch(() => null));
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  const data = record(payload?.data);
  if (!data) throw new Error(`${label} response is invalid`);
  return data;
}

async function workspaceVersion(): Promise<string> {
  const response = await authFetch("projects");
  if (!response.ok) throw new Error(`Workspace version failed: HTTP ${response.status}`);
  const version = response.headers.get("ETag")?.replace(/^"|"$/g, "");
  if (!version?.startsWith("w1-") || version.length !== 67) {
    throw new Error("Workspace version response is invalid");
  }
  return version;
}

export async function importProjectAtomically(
  input: ProjectImportTransactionInput,
): Promise<ProjectImportTransactionResult> {
  const expectedVersion = await workspaceVersion();
  const response = await authFetch("projects/import", {
    method: "POST",
    body: JSON.stringify({ expectedVersion, ...input }),
  });
  const data = await jsonData(response, "Project import transaction");
  return {
    project: structuredClone(input.project),
    ...(input.film ? { film: structuredClone(input.film.document) } : {}),
    migratedStorageKeys: storageKeys(data.migratedStorageKeys),
  };
}

export async function replaceCompleteWorkspace(
  input: CompleteWorkspaceTransactionInput,
): Promise<WorkspaceRestoreReceipt> {
  const expectedVersion = await workspaceVersion();
  const workflowTemplates: WorkflowTemplatesTransactionPayload = {
    version: 1,
    templates: input.snapshot.workflowTemplates.map((template) => structuredClone(template)),
  };
  const response = await authFetch("projects", {
    method: "PUT",
    body: JSON.stringify({
      expectedVersion,
      projects: input.snapshot.projects,
      films: input.films,
      assets: input.snapshot.assets,
      config: input.snapshot.config,
      prompts: input.snapshot.prompts,
      generationJobs: input.snapshot.generationJobs,
      workflowTemplates,
    }),
  });
  const data = await jsonData(response, "Workspace replacement");
  if (typeof data.version !== "string" || typeof data.restoreToken !== "string" || !data.restoreToken) {
    throw new Error("Workspace replacement response is invalid");
  }
  return {
    version: data.version,
    restoreToken: data.restoreToken,
    migratedStorageKeys: storageKeys(data.migratedStorageKeys),
  };
}

export async function rollbackWorkspace(receipt: WorkspaceRestoreReceipt): Promise<string> {
  const response = await authFetch("projects/rollback", {
    method: "POST",
    body: JSON.stringify({ expectedVersion: receipt.version, restoreToken: receipt.restoreToken }),
  });
  const data = await jsonData(response, "Workspace rollback");
  if (typeof data.version !== "string") throw new Error("Workspace rollback response is invalid");
  return data.version;
}
