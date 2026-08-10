import { authFetch } from "@/services/auth-session";
import type { AppConfig, AssetItem, BoardProject, PromptItem } from "@/types/board";
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

/** Compare the durable project representation, ignoring per-session display URLs. */
export function hasPersistedProjectChanges(before: BoardProject, after: BoardProject): boolean {
  return JSON.stringify(stripTransientProjectMedia(before)) !==
    JSON.stringify(stripTransientProjectMedia(after));
}

export class TenantConfigAdminRequiredError extends Error {
  constructor(message = "仅所有者或管理员可以修改租户配置") {
    super(message);
    this.name = "TenantConfigAdminRequiredError";
  }
}

export function configWriteForbiddenMessage(reason: string): string {
  return reason.trim() === "custom channels disabled by admin"
    ? "管理员已禁止普通成员修改个人渠道或渠道密钥"
    : "仅所有者或管理员可以修改租户配置";
}

async function configWriteForbiddenError(response: Response): Promise<TenantConfigAdminRequiredError> {
  return new TenantConfigAdminRequiredError(configWriteForbiddenMessage(await response.text()));
}

export class ConfigPreconditionError extends Error {
  constructor() {
    super("配置已在另一个页面更新，请刷新后重新修改");
    this.name = "ConfigPreconditionError";
  }
}

let configETag: string | null | undefined;
const MAX_CONCURRENT_BLOB_UPLOADS = 2;
const BLOB_UPLOAD_TIMEOUT_MS = 220_000;
let activeBlobUploads = 0;
let blobUploadWaiters: Array<() => void> = [];

function setConfigWriteVersion(headers: Headers): void {
  if (configETag === undefined) throw new ConfigPreconditionError();
  if (configETag === null) {
    headers.set("If-None-Match", "*");
    return;
  }
  headers.set("If-Match", configETag);
  // Some reverse proxies drop standard conditional request headers. Keep the
  // same quoted ETag in an application header so optimistic locking remains
  // enforced instead of turning a valid save into HTTP 428.
  headers.set("X-OpenBoard-Config-Version", configETag);
}

function configWritePath(path: string): string {
  return typeof configETag === "string"
    ? `${path}?configVersion=${encodeURIComponent(configETag)}`
    : path;
}

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
    setConfigWriteVersion(headers);
  }
  const response = await request(key === "config" ? configWritePath(`state/${key}`) : `state/${key}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(value),
  });
	if (key === "config" && response.status === 403) throw await configWriteForbiddenError(response);
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
  const headers = new Headers({ "Content-Type": "application/json" });
  setConfigWriteVersion(headers);
  const response = await request(configWritePath("config"), {
    method: "PUT",
    headers,
    body: JSON.stringify({ config, secrets }),
  });
  if (response.status === 401) throw new SecretAuthRequiredError();
  if (response.status === 403) throw await configWriteForbiddenError(response);
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
  setConfigWriteVersion(headers);
  const response = await request(configWritePath("secrets/config"), {
    method: "PUT",
    headers,
    body: JSON.stringify(value),
  });
  // 401 = no real account session. Prompt/catalog sync must not die on this.
	if (response.status === 401) throw new SecretAuthRequiredError();
	if (response.status === 403) throw await configWriteForbiddenError(response);
  if (response.status === 412 || response.status === 428) throw new ConfigPreconditionError();
  if (!response.ok) throw new Error(`Secret save failed: HTTP ${response.status}`);
  const nextETag = response.headers.get("ETag");
  if (!nextETag) throw new Error("Secret save response is missing ETag");
  configETag = nextETag;
}

export function parseRetryAfterMillis(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.min(timestamp - now, 5_000));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(complete, milliseconds);
    function complete() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function acquireBlobUpload(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (activeBlobUploads < MAX_CONCURRENT_BLOB_UPLOADS) {
    activeBlobUploads += 1;
    return releaseBlobUpload;
  }
  await new Promise<void>((resolve, reject) => {
    const enter = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      blobUploadWaiters = blobUploadWaiters.filter((waiter) => waiter !== enter);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    blobUploadWaiters = [...blobUploadWaiters, enter];
    signal.addEventListener("abort", abort, { once: true });
  });
  if (signal.aborted) {
    releaseBlobUpload();
    signal.throwIfAborted();
  }
  return releaseBlobUpload;
}

function releaseBlobUpload(): void {
  const [next, ...remaining] = blobUploadWaiters;
  blobUploadWaiters = remaining;
  if (next) {
    next();
    return;
  }
  activeBlobUploads = Math.max(0, activeBlobUploads - 1);
}

export async function putServerBlob(key: string, blob: Blob, signal?: AbortSignal): Promise<void> {
  const retryDelays = [750, 2_000];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Blob upload timed out")), BLOB_UPLOAD_TIMEOUT_MS);
  const forwardAbort = () => controller.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  try {
    for (let attempt = 0; ; attempt += 1) {
      controller.signal.throwIfAborted();
      const release = await acquireBlobUpload(controller.signal);
      let response: Response;
      try {
        response = await request(`blobs/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers: { "Content-Type": blob.type || "application/octet-stream" },
          body: blob,
          signal: controller.signal,
        });
      } finally {
        release();
      }
      if (response.ok) return;
      if (response.status !== 429 || attempt >= retryDelays.length) {
        throw new Error(`Blob save failed: HTTP ${response.status}`);
      }
      const requestedDelay = parseRetryAfterMillis(response.headers.get("Retry-After")) ?? retryDelays[attempt]!;
      const jitteredDelay = Math.max(250, Math.round(requestedDelay * (0.8 + Math.random() * 0.4)));
      await abortableDelay(jitteredDelay, controller.signal);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
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
  const mint = async (batch: string[]): Promise<void> => {
    const response = await request("media/references", {
      method: "POST",
      body: JSON.stringify({ storageKeys: batch, ttlSeconds: 3600 }),
    });
    // One stale key must not poison the other nineteen valid display URLs.
    // Bisect only 404 batches; other failures still surface to the caller.
    if (response.status === 404) {
      if (batch.length === 1) return;
      const middle = Math.ceil(batch.length / 2);
      await mint(batch.slice(0, middle));
      await mint(batch.slice(middle));
      return;
    }
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
  };
  for (let offset = 0; offset < keys.length; offset += 20) {
    await mint(keys.slice(offset, offset + 20));
  }
  return urls;
}

export async function deleteServerBlob(key: string): Promise<void> {
  const response = await request(`blobs/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Blob delete failed: HTTP ${response.status}`);
}
