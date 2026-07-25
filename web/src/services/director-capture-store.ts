import { createStore, del, entries, promisifyRequest, set } from "idb-keyval";

import { uid } from "@/lib/id";
import { authFetch } from "@/services/auth-session";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const captureStore = createStore("openboard-director-captures", "captures");

export type DirectorCaptureRecord = {
  id: string;
  ownerScope: string;
  projectId: string;
  directorNodeId: string;
  cameraId: string;
  cameraName: string;
  createdAt: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: "image/png";
  blob?: Blob;
  url?: string;
  orphanedAt?: string;
};

export type DirectorCapture = DirectorCaptureRecord & { blob: Blob };

export type DirectorCaptureInput = Omit<DirectorCapture, "id" | "bytes" | "mimeType" | "orphanedAt" | "url">;

export type DirectorCaptureAdapter = {
  entries: () => Promise<Array<[string, unknown]>>;
  set: (key: string, value: DirectorCapture) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

export type DirectorCaptureLimits = {
  maxPerDirector: number;
  maxGlobal: number;
  maxTotalBytes: number;
  maxBlobBytes: number;
  maxTotalPixels: number;
};

const DEFAULT_LIMITS: DirectorCaptureLimits = {
  maxPerDirector: 100,
  maxGlobal: 300,
  maxTotalBytes: 256 * 1024 * 1024,
  maxBlobBytes: 32 * 1024 * 1024,
  maxTotalPixels: 40_000_000,
};

const OWNER_KEY = "openboard:director-capture-owner";
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
let volatileOwnerScope = uid("browser");
let fallbackWriteQueue = Promise.resolve();

const defaultAdapter: DirectorCaptureAdapter = {
  entries: () => entries(captureStore) as Promise<Array<[string, unknown]>>,
  set: (key, value) => set(key, value, captureStore),
  delete: (key) => del(key, captureStore),
};

function boundedId(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${path} is invalid`);
  return value;
}

function normalizeRecord(value: unknown): DirectorCapture | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<DirectorCapture>;
  try {
    const id = boundedId(input.id, "id");
    const ownerScope = boundedId(input.ownerScope, "ownerScope");
    const projectId = boundedId(input.projectId, "projectId");
    const directorNodeId = boundedId(input.directorNodeId, "directorNodeId");
    const cameraId = boundedId(input.cameraId, "cameraId");
    if (typeof input.cameraName !== "string" || input.cameraName.trim().length < 1 || input.cameraName.length > 100) return null;
    if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) return null;
    const width = input.width;
    const height = input.height;
    if (!Number.isInteger(width) || width! < 1 || width! > 4096) return null;
    if (!Number.isInteger(height) || height! < 1 || height! > 4096) return null;
    if (!(input.blob instanceof Blob) || input.blob.type !== "image/png") return null;
    if (input.mimeType !== "image/png" || input.bytes !== input.blob.size) return null;
    const orphanedAt = input.orphanedAt === undefined
      ? undefined
      : typeof input.orphanedAt === "string" && Number.isFinite(Date.parse(input.orphanedAt))
        ? new Date(input.orphanedAt).toISOString()
        : null;
    if (orphanedAt === null) return null;
    return {
      id,
      ownerScope,
      projectId,
      directorNodeId,
      cameraId,
      cameraName: input.cameraName.trim(),
      createdAt: new Date(input.createdAt).toISOString(),
      width: width!,
      height: height!,
      bytes: input.bytes,
      mimeType: "image/png",
      blob: input.blob,
      orphanedAt,
    };
  } catch {
    return null;
  }
}

function keyFor(record: Pick<DirectorCapture, "ownerScope" | "projectId" | "directorNodeId" | "id">): string {
  return `capture:${record.ownerScope}:${record.projectId}:${record.directorNodeId}:${record.id}`;
}

function copyRecord(record: DirectorCapture): DirectorCapture {
  return { ...record, blob: record.blob.slice(0, record.blob.size, record.blob.type) };
}

export function createDirectorCaptureStore(
  adapter: DirectorCaptureAdapter = defaultAdapter,
  limitOverrides: Partial<DirectorCaptureLimits> = {},
) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const normalizeEntries = (stored: Array<[string, unknown]>): Array<{ key: string; record: DirectorCapture }> =>
    stored.flatMap(([key, value]) => {
      const record = normalizeRecord(value);
      return record && key === keyFor(record) ? [{ key, record }] : [];
    });
  const withWriteLock = async <T>(task: () => Promise<T>): Promise<T> => {
    if (adapter === defaultAdapter && typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request("openboard-director-captures", task);
    }
    const prior = fallbackWriteQueue;
    let release: () => void = () => {};
    fallbackWriteQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await task();
    } finally {
      release();
    }
  };
  const all = async (): Promise<Array<{ key: string; record: DirectorCapture }>> => {
    const stored = (await adapter.entries()).filter((entry): entry is [string, unknown] => typeof entry[0] === "string");
    const valid = normalizeEntries(stored);
    const validKeys = new Set(valid.map(({ key }) => key));
    const invalidKeys = stored.map(([key]) => key).filter((key) => key.startsWith("capture:") && !validKeys.has(key));
    await Promise.all(invalidKeys.map((key) => adapter.delete(key)));
    return valid;
  };

  return {
    async list(ownerScope: string, projectId: string, directorNodeId: string): Promise<DirectorCapture[]> {
      boundedId(ownerScope, "ownerScope");
      boundedId(projectId, "projectId");
      boundedId(directorNodeId, "directorNodeId");
      return (await all())
        .filter(({ record }) => record.ownerScope === ownerScope && record.projectId === projectId && record.directorNodeId === directorNodeId)
        .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || b.record.id.localeCompare(a.record.id))
        .map(({ record }) => copyRecord(record));
    },

    async add(input: DirectorCaptureInput): Promise<DirectorCapture> {
      const ownerScope = boundedId(input.ownerScope, "ownerScope");
      const projectId = boundedId(input.projectId, "projectId");
      const directorNodeId = boundedId(input.directorNodeId, "directorNodeId");
      const cameraId = boundedId(input.cameraId, "cameraId");
      if (typeof input.cameraName !== "string" || input.cameraName.trim().length < 1 || input.cameraName.length > 100) {
        throw new Error("cameraName is invalid");
      }
      if (!(input.blob instanceof Blob) || input.blob.type !== "image/png") throw new Error("Capture must be a PNG image");
      if (input.blob.size < 1 || input.blob.size > limits.maxBlobBytes) {
        throw new Error(`Capture exceeds ${limits.maxBlobBytes} bytes`);
      }
      if (!Number.isInteger(input.width) || input.width < 1 || input.width > 4096 ||
          !Number.isInteger(input.height) || input.height < 1 || input.height > 4096) {
        throw new Error("Capture dimensions are invalid");
      }
      if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("createdAt is invalid");
      const commit = async (
        stored: Array<{ key: string; record: DirectorCapture }>,
        write: (record: DirectorCapture) => Promise<void>,
      ): Promise<DirectorCapture> => {
        const owned = stored.filter(({ record }) => record.ownerScope === ownerScope);
        const perDirector = owned.filter(({ record }) =>
          record.projectId === projectId && record.directorNodeId === directorNodeId
        );
        if (perDirector.length >= limits.maxPerDirector) {
          throw new Error(`Capture tray is limited to ${limits.maxPerDirector} items`);
        }
        if (stored.length >= limits.maxGlobal) throw new Error(`Capture storage is limited to ${limits.maxGlobal} items`);
        const totalBytes = stored.reduce((total, { record }) => total + record.bytes, 0);
        if (totalBytes + input.blob.size > limits.maxTotalBytes) {
          throw new Error(`Capture storage exceeds ${limits.maxTotalBytes} bytes`);
        }
        const totalPixels = stored.reduce((total, { record }) => total + record.width * record.height, 0);
        if (totalPixels + input.width * input.height > limits.maxTotalPixels) {
          throw new Error(`Capture storage exceeds ${limits.maxTotalPixels} pixels`);
        }
        const record: DirectorCapture = {
          id: uid("capture"),
          ownerScope,
          projectId,
          directorNodeId,
          cameraId,
          cameraName: input.cameraName.trim(),
          createdAt: new Date(input.createdAt).toISOString(),
          width: input.width,
          height: input.height,
          bytes: input.blob.size,
          mimeType: "image/png",
          blob: input.blob,
        };
        await write(record);
        return copyRecord(record);
      };
      if (adapter === defaultAdapter) {
        return captureStore("readwrite", async (store) => {
          const [keys, values] = await Promise.all([
            promisifyRequest(store.getAllKeys()),
            promisifyRequest(store.getAll()),
          ]);
          const raw = keys.flatMap((key, index) =>
            typeof key === "string" ? [[key, values[index]] as [string, unknown]] : []
          );
          const stored = normalizeEntries(raw);
          const validKeys = new Set(stored.map(({ key }) => key));
          await Promise.all(raw
            .map(([key]) => key)
            .filter((key) => key.startsWith("capture:") && !validKeys.has(key))
            .map((key) => promisifyRequest(store.delete(key))));
          return commit(stored, async (record) => {
            await promisifyRequest(store.put(record, keyFor(record)));
          });
        });
      }
      return withWriteLock(async () => {
        return commit(await all(), async (record) => adapter.set(keyFor(record), record));
      });
    },

    async deleteMany(ownerScope: string, projectId: string, directorNodeId: string, ids: readonly string[]): Promise<void> {
      boundedId(ownerScope, "ownerScope");
      boundedId(projectId, "projectId");
      boundedId(directorNodeId, "directorNodeId");
      const requested = new Set(ids.map((id) => boundedId(id, "captureId")));
      await withWriteLock(async () => {
        const matches = (await all()).filter(({ record }) =>
          record.ownerScope === ownerScope && record.projectId === projectId && record.directorNodeId === directorNodeId && requested.has(record.id)
        );
        await Promise.all(matches.map(({ key }) => adapter.delete(key)));
      });
    },

    async clear(ownerScope: string, projectId: string, directorNodeId: string): Promise<void> {
      boundedId(ownerScope, "ownerScope");
      boundedId(projectId, "projectId");
      boundedId(directorNodeId, "directorNodeId");
      await withWriteLock(async () => {
        const matches = (await all()).filter(({ record }) =>
          record.ownerScope === ownerScope && record.projectId === projectId && record.directorNodeId === directorNodeId
        );
        await Promise.all(matches.map(({ key }) => adapter.delete(key)));
      });
    },

    async prune(
      ownerScope: string,
      validDirectors: Readonly<Record<string, readonly string[]>>,
      now = Date.now(),
    ): Promise<void> {
      boundedId(ownerScope, "ownerScope");
      const allowed = new Map(Object.entries(validDirectors).map(([projectId, directorIds]) => [
        boundedId(projectId, "projectId"),
        new Set(directorIds.map((id) => boundedId(id, "directorNodeId"))),
      ]));
      await withWriteLock(async () => {
        const owned = (await all()).filter(({ record }) => record.ownerScope === ownerScope);
        const deletes: string[] = [];
        const updates: DirectorCapture[] = [];
        for (const { key, record } of owned) {
          const directors = allowed.get(record.projectId);
          if (!directors) {
            deletes.push(key);
          } else if (directors.has(record.directorNodeId)) {
            if (record.orphanedAt) updates.push({ ...record, orphanedAt: undefined });
          } else if (!record.orphanedAt) {
            updates.push({ ...record, orphanedAt: new Date(now).toISOString() });
          } else if (Date.parse(record.orphanedAt) <= now - ORPHAN_GRACE_MS) {
            deletes.push(key);
          }
        }
        await Promise.all([
          ...deletes.map((key) => adapter.delete(key)),
          ...updates.map((record) => adapter.set(keyFor(record), record)),
        ]);
      });
    },

    async resolve(record: DirectorCaptureRecord): Promise<DirectorCapture> {
      if (!(record.blob instanceof Blob) || record.blob.type !== "image/png" || record.blob.size !== record.bytes) {
        throw new Error("Capture media is unavailable");
      }
      return copyRecord(record as DirectorCapture);
    },
  };
}

const localDirectorCaptureStore = createDirectorCaptureStore();

type ServerDirectorCapture = Omit<DirectorCaptureRecord, "ownerScope" | "blob" | "orphanedAt"> & { url: string };

function parseServerCapture(value: unknown, ownerScope: string): DirectorCaptureRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Director capture response is invalid");
  const input = value as Partial<ServerDirectorCapture>;
  const id = boundedId(input.id, "id");
  const projectId = boundedId(input.projectId, "projectId");
  const directorNodeId = boundedId(input.directorNodeId, "directorNodeId");
  const cameraId = boundedId(input.cameraId, "cameraId");
  if (typeof input.cameraName !== "string" || !input.cameraName.trim() || input.cameraName.length > 100) {
    throw new Error("Director capture response is invalid");
  }
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt)) ||
      !Number.isInteger(input.width) || input.width! < 1 || input.width! > 4096 ||
      !Number.isInteger(input.height) || input.height! < 1 || input.height! > 4096 ||
      !Number.isInteger(input.bytes) || input.bytes! < 1 || input.bytes! > DEFAULT_LIMITS.maxBlobBytes ||
      input.mimeType !== "image/png" || typeof input.url !== "string" || !input.url.startsWith("/api/blobs/")) {
    throw new Error("Director capture response is invalid");
  }
  let storageKey = "";
  try {
    storageKey = decodeURIComponent(input.url.slice("/api/blobs/".length));
  } catch {
    throw new Error("Director capture response is invalid");
  }
  if (storageKey !== `director-capture:${id}`) throw new Error("Director capture response is invalid");
  return {
    id,
    ownerScope: boundedId(ownerScope, "ownerScope"),
    projectId,
    directorNodeId,
    cameraId,
    cameraName: input.cameraName.trim(),
    createdAt: new Date(input.createdAt).toISOString(),
    width: input.width!,
    height: input.height!,
    bytes: input.bytes!,
    mimeType: "image/png",
    url: input.url,
  };
}

async function serverJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(path, init);
  if (!response.ok) throw new Error(`Director capture storage failed: HTTP ${response.status}`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function resolveServerCapture(record: DirectorCaptureRecord): Promise<DirectorCapture> {
  if (record.blob instanceof Blob) return { ...record, blob: record.blob.slice(0, record.blob.size, record.blob.type) };
  if (!record.url?.startsWith("/api/blobs/")) throw new Error("Capture media is unavailable");
  const response = await authFetch(record.url.slice("/api/".length));
  if (!response.ok) throw new Error(`Capture media failed: HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.type !== "image/png" || blob.size !== record.bytes || blob.size > DEFAULT_LIMITS.maxBlobBytes) {
    throw new Error("Capture media is invalid");
  }
  return { ...record, blob };
}

const serverDirectorCaptureStore = {
  async list(ownerScope: string, projectId: string, directorNodeId: string): Promise<DirectorCaptureRecord[]> {
    boundedId(ownerScope, "ownerScope");
    boundedId(projectId, "projectId");
    boundedId(directorNodeId, "directorNodeId");
    const values = await serverJSON<unknown[]>(`director-captures?${new URLSearchParams({ projectId, directorNodeId })}`);
    if (!Array.isArray(values) || values.length > DEFAULT_LIMITS.maxPerDirector) throw new Error("Director capture response is invalid");
    const metadata = values.map((value) => parseServerCapture(value, ownerScope));
    const records: DirectorCapture[] = [];
    for (let index = 0; index < metadata.length; index += 4) {
      records.push(...await Promise.all(metadata.slice(index, index + 4).map(resolveServerCapture)));
    }
    return records;
  },

  async add(input: DirectorCaptureInput): Promise<DirectorCaptureRecord> {
    boundedId(input.ownerScope, "ownerScope");
    const params = new URLSearchParams({
      projectId: boundedId(input.projectId, "projectId"),
      directorNodeId: boundedId(input.directorNodeId, "directorNodeId"),
      cameraId: boundedId(input.cameraId, "cameraId"),
      cameraName: input.cameraName,
      createdAt: input.createdAt,
      width: String(input.width),
      height: String(input.height),
    });
    const value = await serverJSON<unknown>(`director-captures?${params}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: input.blob,
    });
    return parseServerCapture(value, input.ownerScope);
  },

  async deleteMany(ownerScope: string, projectId: string, directorNodeId: string, ids: readonly string[]): Promise<void> {
    boundedId(ownerScope, "ownerScope");
    boundedId(projectId, "projectId");
    boundedId(directorNodeId, "directorNodeId");
    const safeIds = ids.map((id) => boundedId(id, "captureId"));
    for (let index = 0; index < safeIds.length; index += 8) {
      await Promise.all(safeIds.slice(index, index + 8).map((id) =>
        serverJSON<void>(`director-captures/${encodeURIComponent(id)}`, { method: "DELETE" })
      ));
    }
  },

  async clear(ownerScope: string, projectId: string, directorNodeId: string): Promise<void> {
    const records = await serverDirectorCaptureStore.list(ownerScope, projectId, directorNodeId);
    await serverDirectorCaptureStore.deleteMany(ownerScope, projectId, directorNodeId, records.map(({ id }) => id));
  },

  async prune(ownerScope: string, validDirectors: Readonly<Record<string, readonly string[]>>): Promise<void> {
    boundedId(ownerScope, "ownerScope");
    const projects = Object.fromEntries(Object.entries(validDirectors).map(([projectId, directorIds]) => [
      boundedId(projectId, "projectId"),
      directorIds.map((id) => boundedId(id, "directorNodeId")),
    ]));
    await serverJSON<void>("director-captures/prune", {
      method: "PUT",
      body: JSON.stringify({ projects }),
    });
  },

  async resolve(record: DirectorCaptureRecord): Promise<DirectorCapture> {
    return resolveServerCapture(record);
  },
};

export const directorCaptureStore = import.meta.env.VITE_OPENBOARD_STORAGE === "server"
  ? serverDirectorCaptureStore
  : localDirectorCaptureStore;

export function getDirectorCaptureOwnerScope(user?: { id: string; tenantId: string } | null): string {
  if (user) return boundedId(`user:${user.tenantId}:${user.id}`, "ownerScope");
  if (typeof localStorage === "undefined") return volatileOwnerScope;
  try {
    const stored = localStorage.getItem(OWNER_KEY);
    if (stored && ID_PATTERN.test(stored)) return stored;
    volatileOwnerScope = uid("browser");
    localStorage.setItem(OWNER_KEY, volatileOwnerScope);
  } catch {
    // Private browsing may deny storage; the process-local scope still isolates this session.
  }
  return volatileOwnerScope;
}
