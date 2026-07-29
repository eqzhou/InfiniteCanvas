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

function isTransientMediaUrl(value: unknown): value is string {
  return typeof value === "string" &&
    (value.startsWith("blob:") || value.startsWith("/api/media/references/"));
}

function stripTransientProjectMedia(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const project = value as Record<string, unknown>;
  const nodes = Array.isArray(project.nodes)
    ? project.nodes.map((rawNode) => {
        if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) return rawNode;
        const node = rawNode as Record<string, unknown>;
        if (!node.metadata || typeof node.metadata !== "object" || Array.isArray(node.metadata)) return rawNode;
        const metadata = node.metadata as Record<string, unknown>;
        if (typeof metadata.storageKey !== "string" || !isTransientMediaUrl(metadata.content)) return rawNode;
        const { content: _content, ...persistedMetadata } = metadata;
        return { ...node, metadata: persistedMetadata };
      })
    : project.nodes;
  const chatSessions = Array.isArray(project.chatSessions)
    ? project.chatSessions.map((rawSession) => {
        if (!rawSession || typeof rawSession !== "object" || Array.isArray(rawSession)) return rawSession;
        const session = rawSession as Record<string, unknown>;
        if (!Array.isArray(session.messages)) return rawSession;
        const messages = session.messages.map((rawMessage) => {
          if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) return rawMessage;
          const message = rawMessage as Record<string, unknown>;
          const images = Array.isArray(message.images)
            ? message.images.map((rawImage) => {
                if (!rawImage || typeof rawImage !== "object" || Array.isArray(rawImage)) return rawImage;
                const image = rawImage as Record<string, unknown>;
                return typeof image.storageKey === "string" && isTransientMediaUrl(image.url)
                  ? { ...image, url: "" }
                  : rawImage;
              })
            : message.images;
          const references = Array.isArray(message.references)
            ? message.references.map((rawReference) => {
                if (!rawReference || typeof rawReference !== "object" || Array.isArray(rawReference)) return rawReference;
                const reference = rawReference as Record<string, unknown>;
                if (typeof reference.storageKey !== "string" || !isTransientMediaUrl(reference.preview)) {
                  return rawReference;
                }
                const { preview: _preview, ...persistedReference } = reference;
                return persistedReference;
              })
            : message.references;
          return { ...message, images, references };
        });
        return { ...session, messages };
      })
    : project.chatSessions;
  return { ...project, nodes, chatSessions };
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

export class ConfigPreconditionError extends Error {
  constructor() {
    super("配置已在另一个页面更新，请刷新后重新修改");
    this.name = "ConfigPreconditionError";
  }
}

let configETag: string | null | undefined;

export function resetServerStateVersions(): void {
  configETag = undefined;
}

export async function loadServerConfigBundle<T>(): Promise<{ config: AppConfig; secrets: T } | null> {
  const response = await request("config");
  if (response.status === 404) {
    configETag = null;
    return null;
  }
  if (response.status === 401) throw new SecretAuthRequiredError();
  if (response.status === 403) throw new TenantConfigAdminRequiredError();
  if (!response.ok) throw new Error(`Config load failed: HTTP ${response.status}`);
  const etag = response.headers.get("ETag");
  if (!etag) throw new Error("Config load response is missing ETag");
  const value = await response.json() as { config?: unknown; secrets?: unknown };
  if (!value || typeof value !== "object" || !value.config || typeof value.config !== "object" ||
      !value.secrets || typeof value.secrets !== "object") {
    throw new Error("Config load response is invalid");
  }
  configETag = etag;
  return value as { config: AppConfig; secrets: T };
}

/**
 * Secrets require a real signed-in account (or auth_mode=off + process token).
 * Callers that only persist non-secret state should catch this and continue.
 */
export class SecretAuthRequiredError extends Error {
  constructor(message = "保存密钥需要登录账号") {
    super(message);
    this.name = "SecretAuthRequiredError";
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

export class MigrationCapabilitiesUnavailableError extends Error {
  constructor() {
    super("无法确认服务端迁移权限，已保留本地数据。请稍后重试。");
    this.name = "MigrationCapabilitiesUnavailableError";
  }
}

/**
 * Server-declared migration capabilities. Secret migration rights must come
 * from the server, never from a client-side role copy; write endpoints enforce
 * the same rule independently.
 *
 * A denial ("server says no") and an unreachable server ("could not ask") must
 * stay distinguishable. Treating a transient network failure as a denial would
 * migrate without secrets and then clear the local stores that hold them,
 * destroying the only copy.
 */
export async function loadMigrationCapabilities(): Promise<{ allowSecrets: boolean }> {
  let response: Response;
  try {
    response = await request("migration/capabilities");
  } catch {
    throw new MigrationCapabilitiesUnavailableError();
  }
  // 401/403 are authoritative denials; anything else means we could not ask.
  if (response.status === 401 || response.status === 403) return { allowSecrets: false };
  if (!response.ok) throw new MigrationCapabilitiesUnavailableError();
  try {
    const payload = (await response.json()) as { allowSecrets?: unknown };
    return { allowSecrets: payload?.allowSecrets === true };
  } catch {
    throw new MigrationCapabilitiesUnavailableError();
  }
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
  return migrationWrite(
    `projects/${encodeURIComponent(project.id)}`,
    JSON.stringify(stripTransientProjectMedia(project)),
    "application/json",
    expectedVersion,
  );
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
  return Promise.all(summaries.map(async ({ id }) => {
    const raw = await readJSON<unknown>(await request(`projects/${encodeURIComponent(id)}`));
    return parseBoardProject(stripTransientProjectMedia(raw));
  }));
}

/**
 * Upsert the provided projects without deleting any remote project absent from
 * this list. Returns the ids the server reported as deleted (HTTP 410) so the
 * caller can drop them locally: a tombstone is authoritative and retrying the
 * write would never succeed.
 */
export async function saveServerProjects(projects: BoardProject[]): Promise<string[]> {
  const gone = await Promise.all(projects.map(async (project) => {
    const response = await request(`projects/${encodeURIComponent(project.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stripTransientProjectMedia(project)),
    });
    if (response.status === 410) return project.id;
    if (!response.ok) throw new Error(`Project save failed: HTTP ${response.status}`);
    return null;
  }));
  return gone.filter((id): id is string => id !== null);
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
  if (response.status === 404) {
    if (key === "config") configETag = null;
    return null;
  }
  if (key === "config" && response.ok) configETag = response.headers.get("ETag");
  return readJSON<T>(response);
}

export async function saveServerState(
  key: "config" | "assets" | "prompts",
  value: AppConfig | AssetItem[] | PromptItem[],
): Promise<void> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (key === "config") {
    if (configETag === undefined) throw new ConfigPreconditionError();
    if (configETag === null) headers.set("If-None-Match", "*");
    else headers.set("If-Match", configETag);
  }
  const response = await request(`state/${key}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(value),
  });
	if (key === "config" && response.status === 403) throw new TenantConfigAdminRequiredError();
  if (key === "config" && (response.status === 412 || response.status === 428)) throw new ConfigPreconditionError();
  if (!response.ok) throw new Error(`State save failed: HTTP ${response.status}`);
  if (key === "config") {
    const nextETag = response.headers.get("ETag");
    if (!nextETag) throw new Error("Config save response is missing ETag");
    configETag = nextETag;
  }
}

export async function saveServerConfigBundle<T>(
  config: AppConfig,
  secrets: T,
): Promise<void> {
  if (configETag === undefined) throw new ConfigPreconditionError();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (configETag === null) headers.set("If-None-Match", "*");
  else headers.set("If-Match", configETag);
  const response = await request("config", {
    method: "PUT",
    headers,
    body: JSON.stringify({ config, secrets }),
  });
  if (response.status === 401) throw new SecretAuthRequiredError();
  if (response.status === 403) throw new TenantConfigAdminRequiredError();
  if (response.status === 412 || response.status === 428) throw new ConfigPreconditionError();
  if (!response.ok) throw new Error(`Config save failed: HTTP ${response.status}`);
  const nextETag = response.headers.get("ETag");
  if (!nextETag) throw new Error("Config save response is missing ETag");
  configETag = nextETag;
}

export async function loadServerSecrets<T>(): Promise<T | null> {
  const response = await request("secrets/config");
  // Guests / unauthenticated sessions cannot read secret bags. Members can use
  // the shared secret-free catalog but must never receive tenant credentials.
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  return readJSON<T>(response);
}

export async function saveServerSecrets<T>(value: T): Promise<void> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (configETag) headers.set("If-Match", configETag);
  const response = await request("secrets/config", {
    method: "PUT",
    headers,
    body: JSON.stringify(value),
  });
  // 401 = no real account session. Prompt/catalog sync must not die on this.
	if (response.status === 401) throw new SecretAuthRequiredError();
	if (response.status === 403) throw new TenantConfigAdminRequiredError();
  if (response.status === 412 || response.status === 428) throw new ConfigPreconditionError();
  if (!response.ok) throw new Error(`Secret save failed: HTTP ${response.status}`);
  const nextETag = response.headers.get("ETag");
  if (!nextETag) throw new Error("Secret save response is missing ETag");
  configETag = nextETag;
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

export async function createServerBlobDisplayUrls(
  storageKeys: readonly string[],
): Promise<Map<string, string>> {
  const keys = Array.from(new Set(storageKeys.map((key) => key.trim()).filter(Boolean)));
  const urls = new Map<string, string>();
  for (let offset = 0; offset < keys.length; offset += 20) {
    const batch = keys.slice(offset, offset + 20);
    const response = await request("media/references", {
      method: "POST",
      body: JSON.stringify({ storageKeys: batch, ttlSeconds: 3600 }),
    });
    if (!response.ok) throw new Error(`Blob display URL creation failed: HTTP ${response.status}`);
    const payload = await response.json() as { items?: unknown };
    if (!Array.isArray(payload.items)) throw new Error("Blob display URL response is invalid");
    const expected = new Set(batch);
    for (const raw of payload.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Blob display URL response is invalid");
      }
      const item = raw as { token?: unknown; storageKey?: unknown };
      if (typeof item.token !== "string" || !item.token || item.token.length > 256 ||
          typeof item.storageKey !== "string" || !expected.has(item.storageKey)) {
        throw new Error("Blob display URL response is invalid");
      }
      urls.set(item.storageKey, `/api/media/references/${encodeURIComponent(item.token)}`);
    }
  }
  return urls;
}

export async function deleteServerBlob(key: string): Promise<void> {
  const response = await request(`blobs/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Blob delete failed: HTTP ${response.status}`);
}
