import { authFetch } from "@/services/auth-session";
import type { AppConfig, AssetItem, BoardProject, GenerationJob, PromptItem } from "@/types/board";
import { parseBoardProject } from "@/lib/board-document";

async function request(path: string, init?: RequestInit): Promise<Response> {
  return authFetch(path, init);
}

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Server storage failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export type MigrationResourceRef = {
  kind: "project" | "state" | "secret" | "blob" | "generation-history";
  id: string;
};

export type MigrationResourceVersion = MigrationResourceRef & {
  exists: boolean;
  version?: string;
};

export class MigrationPreconditionError extends Error {
  constructor() {
    super("Remote data changed after migration preflight");
    this.name = "MigrationPreconditionError";
  }
}

export class TenantConfigAdminRequiredError extends Error {
  constructor() {
    super("Tenant configuration can only be changed by an owner or admin");
    this.name = "TenantConfigAdminRequiredError";
  }
}

export async function loadMigrationResourceVersions(
  resources: readonly MigrationResourceRef[],
): Promise<MigrationResourceVersion[]> {
  const result: MigrationResourceVersion[] = [];
  for (let offset = 0; offset < resources.length; offset += 100) {
    const response = await request("migration/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resources: resources.slice(offset, offset + 100) }),
    });
    const page = await readJSON<{ resources?: unknown }>(response);
    if (!Array.isArray(page.resources) || page.resources.length !== Math.min(100, resources.length - offset)) {
      throw new Error("Migration version response is invalid");
    }
    page.resources.forEach((raw, index) => {
      const expected = resources[offset + index]!;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Migration version response is invalid");
      const item = raw as Partial<MigrationResourceVersion>;
      const validVersion = typeof item.version === "string" && /^m1-[0-9a-f]{64}$/.test(item.version);
      if (item.kind !== expected.kind || item.id !== expected.id || typeof item.exists !== "boolean" ||
          (item.exists ? !validVersion : item.version !== undefined)) {
        throw new Error("Migration version response is invalid");
      }
      result.push({ kind: item.kind, id: item.id, exists: item.exists, ...(validVersion ? { version: item.version } : {}) } as MigrationResourceVersion);
    });
  }
  return result;
}

function migrationHeaders(contentType: string, expectedVersion: string | null): Record<string, string> {
  return expectedVersion === null
    ? { "Content-Type": contentType, "If-None-Match": "*" }
    : { "Content-Type": contentType, "If-Match": `"${expectedVersion}"` };
}

async function migrationWrite(path: string, body: BodyInit, contentType: string, expectedVersion: string | null): Promise<void> {
  const response = await request(`migration/${path}`, {
    method: "PUT",
    headers: migrationHeaders(contentType, expectedVersion),
    body,
  });
  if (response.status === 409 || response.status === 412) throw new MigrationPreconditionError();
  if (!response.ok) throw new Error(`Migration write failed: HTTP ${response.status}`);
}

export function saveMigrationProject(project: BoardProject, expectedVersion: string | null): Promise<void> {
  return migrationWrite(`projects/${encodeURIComponent(project.id)}`, JSON.stringify(project), "application/json", expectedVersion);
}

export function saveMigrationState(
  key: "config" | "assets" | "prompts",
  value: AppConfig | AssetItem[] | PromptItem[],
  expectedVersion: string | null,
): Promise<void> {
  return migrationWrite(`state/${key}`, JSON.stringify(value), "application/json", expectedVersion);
}

export function saveMigrationSecrets<T>(value: T, expectedVersion: string | null): Promise<void> {
  return migrationWrite("secrets/config", JSON.stringify(value), "application/json", expectedVersion);
}

export function saveMigrationBlob(key: string, blob: Blob, expectedVersion: string | null): Promise<void> {
  return migrationWrite(`blobs/${encodeURIComponent(key)}`, blob, blob.type || "application/octet-stream", expectedVersion);
}

export function saveMigrationGenerationHistory(jobs: GenerationJob[], expectedVersion: string | null): Promise<void> {
  return migrationWrite("generation-history", JSON.stringify(jobs), "application/json", expectedVersion);
}

export async function loadServerProjects(): Promise<BoardProject[]> {
  const summaries = await readJSON<Array<{ id: string }>>(await request("projects"));
  return Promise.all(summaries.map(async ({ id }) =>
    parseBoardProject(await readJSON<unknown>(await request(`projects/${encodeURIComponent(id)}`))),
  ));
}

/** Upsert the provided projects without deleting any remote project absent from this list. */
export async function saveServerProjects(projects: BoardProject[]): Promise<void> {
  await Promise.all(projects.map(async (project) => {
    const response = await request(`projects/${encodeURIComponent(project.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    });
    if (!response.ok) throw new Error(`Project save failed: HTTP ${response.status}`);
  }));
}

/** Explicit single-project delete used by user-driven project removal. */
export async function deleteServerProject(projectId: string): Promise<void> {
  const response = await request(`projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Project delete failed: HTTP ${response.status}`);
  }
}

/**
 * Full workspace replacement: upsert the provided set, then delete remote projects
 * that are not part of the replacement. Ordinary autosave must not use this path.
 */
export async function replaceServerProjects(projects: BoardProject[]): Promise<void> {
  const remote = await readJSON<Array<{ id: string }>>(await request("projects"));
  const localIDs = new Set(projects.map((project) => project.id));
  await saveServerProjects(projects);
  await Promise.all(
    remote
      .filter(({ id }) => !localIDs.has(id))
      .map(({ id }) => deleteServerProject(id)),
  );
}

export async function loadServerState<T>(key: "config" | "assets" | "prompts"): Promise<T | null> {
  const response = await request(`state/${key}`);
  if (response.status === 404) return null;
  return readJSON<T>(response);
}

export async function saveServerState(
  key: "config" | "assets" | "prompts",
  value: AppConfig | AssetItem[] | PromptItem[],
): Promise<void> {
  const response = await request(`state/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
	if (key === "config" && response.status === 403) throw new TenantConfigAdminRequiredError();
  if (!response.ok) throw new Error(`State save failed: HTTP ${response.status}`);
}

export async function loadServerSecrets<T>(): Promise<T | null> {
  const response = await request("secrets/config");
  // Tenant members can use the shared, secret-free config catalog but must
  // never receive tenant credentials.
  if (response.status === 403 || response.status === 404) return null;
  return readJSON<T>(response);
}

export async function saveServerSecrets<T>(value: T): Promise<void> {
  const response = await request("secrets/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
	if (response.status === 403) throw new TenantConfigAdminRequiredError();
  if (!response.ok) throw new Error(`Secret save failed: HTTP ${response.status}`);
}

export async function putServerBlob(key: string, blob: Blob): Promise<void> {
  const response = await request(`blobs/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) throw new Error(`Blob save failed: HTTP ${response.status}`);
}

export async function getServerBlob(key: string): Promise<Blob | undefined> {
  const response = await request(`blobs/${encodeURIComponent(key)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Blob read failed: HTTP ${response.status}`);
  return response.blob();
}

export async function deleteServerBlob(key: string): Promise<void> {
  const response = await request(`blobs/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Blob delete failed: HTTP ${response.status}`);
}
