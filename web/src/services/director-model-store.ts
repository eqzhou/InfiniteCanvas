import { createStore, del, entries, get, promisifyRequest, set } from "idb-keyval";

import { validateDirectorGlb } from "@/lib/director-glb";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,160}\.glb$/i;
const modelStore = createStore("openboard-director-models", "models");
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export { validateDirectorGlb } from "@/lib/director-glb";

export type DirectorModelRecord = {
  ownerScope: string;
  projectId: string;
  directorNodeId: string;
  objectId: string;
  assetId: string;
  fileName: string;
  bytes: number;
  mimeType: "model/gltf-binary";
  createdAt: string;
  blob: Blob;
  orphanedAt?: string;
};

export type DirectorModelIdentity = Pick<DirectorModelRecord,
  "ownerScope" | "projectId" | "directorNodeId" | "objectId" | "assetId">;

export type DirectorModelInput = DirectorModelIdentity & {
  fileName: string;
  blob: Blob;
};

export type DirectorModelAdapter = {
  entries: () => Promise<Array<[string, unknown]>>;
  set: (key: string, value: DirectorModelRecord) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

export type DirectorModelLimits = {
  maxGlobal: number;
  maxTotalBytes: number;
  maxBlobBytes: number;
};

const DEFAULT_LIMITS: DirectorModelLimits = {
  maxGlobal: 100,
  maxTotalBytes: 512 * 1024 * 1024,
  maxBlobBytes: 100 * 1024 * 1024,
};

const defaultAdapter: DirectorModelAdapter = {
  entries: () => entries(modelStore) as Promise<Array<[string, unknown]>>,
  set: (key, value) => set(key, value, modelStore),
  delete: (key) => del(key, modelStore),
};

let fallbackWriteQueue = Promise.resolve();

function boundedId(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${path} is invalid`);
  return value;
}

function boundedFileName(value: unknown): string {
  if (typeof value !== "string") throw new Error("fileName is invalid");
  const fileName = value.trim();
  if (!SAFE_FILE_NAME.test(fileName) || fileName === ".glb") throw new Error("fileName is invalid");
  return fileName;
}

function keyFor(identity: DirectorModelIdentity): string {
  return `model:${[
    identity.ownerScope,
    identity.projectId,
    identity.directorNodeId,
    identity.objectId,
    identity.assetId,
  ].map((segment) => encodeURIComponent(segment)).join(":")}`;
}

function directorPrefix(identity: Pick<DirectorModelIdentity, "ownerScope" | "projectId" | "directorNodeId">): string {
  return `model:${[identity.ownerScope, identity.projectId, identity.directorNodeId]
    .map((segment) => encodeURIComponent(segment)).join(":")}:`;
}

function sameIdentity(left: DirectorModelIdentity, right: DirectorModelIdentity): boolean {
  return left.ownerScope === right.ownerScope && left.projectId === right.projectId &&
    left.directorNodeId === right.directorNodeId && left.objectId === right.objectId && left.assetId === right.assetId;
}

function normalizeRecord(value: unknown): DirectorModelRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<DirectorModelRecord>;
  try {
    const identity: DirectorModelIdentity = {
      ownerScope: boundedId(input.ownerScope, "ownerScope"),
      projectId: boundedId(input.projectId, "projectId"),
      directorNodeId: boundedId(input.directorNodeId, "directorNodeId"),
      objectId: boundedId(input.objectId, "objectId"),
      assetId: boundedId(input.assetId, "assetId"),
    };
    const fileName = boundedFileName(input.fileName);
    if (!(input.blob instanceof Blob) || input.mimeType !== "model/gltf-binary" || input.blob.type !== input.mimeType ||
        input.bytes !== input.blob.size || input.bytes < 20 || input.bytes > DEFAULT_LIMITS.maxBlobBytes) return null;
    if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) return null;
    const orphanedAt = input.orphanedAt === undefined
      ? undefined
      : typeof input.orphanedAt === "string" && Number.isFinite(Date.parse(input.orphanedAt))
        ? new Date(input.orphanedAt).toISOString()
        : null;
    if (orphanedAt === null) return null;
    return {
      ...identity,
      fileName,
      bytes: input.bytes,
      mimeType: "model/gltf-binary",
      createdAt: new Date(input.createdAt).toISOString(),
      blob: input.blob,
      orphanedAt,
    };
  } catch {
    return null;
  }
}

function copyRecord(record: DirectorModelRecord): DirectorModelRecord {
  return { ...record, blob: record.blob.slice(0, record.blob.size, record.blob.type) };
}

export function createDirectorModelStore(
  adapter: DirectorModelAdapter = defaultAdapter,
  overrides: Partial<DirectorModelLimits> = {},
) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const normalizeEntries = (stored: Array<[string, unknown]>): Array<{ key: string; record: DirectorModelRecord }> =>
    stored.flatMap(([key, value]) => {
      const record = normalizeRecord(value);
      return record && key === keyFor(record) ? [{ key, record }] : [];
    });
  const withWriteLock = async <T>(task: () => Promise<T>): Promise<T> => {
    if (adapter === defaultAdapter && typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request("openboard-director-models", task);
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
  const all = async (cleanup = false): Promise<Array<{ key: string; record: DirectorModelRecord }>> => {
    const raw = (await adapter.entries()).filter((entry): entry is [string, unknown] => typeof entry[0] === "string");
    const valid = normalizeEntries(raw);
    const validKeys = new Set(valid.map(({ key }) => key));
    if (cleanup) {
      await Promise.all(raw
        .map(([key]) => key)
        .filter((key) => key.startsWith("model:") && !validKeys.has(key))
        .map((key) => adapter.delete(key)));
    }
    return valid;
  };
  const identity = (value: DirectorModelIdentity): DirectorModelIdentity => ({
    ownerScope: boundedId(value.ownerScope, "ownerScope"),
    projectId: boundedId(value.projectId, "projectId"),
    directorNodeId: boundedId(value.directorNodeId, "directorNodeId"),
    objectId: boundedId(value.objectId, "objectId"),
    assetId: boundedId(value.assetId, "assetId"),
  });
  const commit = async (
    stored: Array<{ key: string; record: DirectorModelRecord }>,
    input: DirectorModelInput,
    write: (record: DirectorModelRecord) => Promise<void>,
  ): Promise<DirectorModelRecord> => {
    const safeIdentity = identity(input);
    const fileName = boundedFileName(input.fileName);
    const key = keyFor(safeIdentity);
    const existing = stored.find((entry) => entry.key === key);
    const others = stored.filter((entry) => entry.key !== key);
    if (!existing && others.length >= limits.maxGlobal) throw new Error(`Model storage is limited to ${limits.maxGlobal} items`);
    const totalBytes = others.reduce((sum, entry) => sum + entry.record.bytes, 0);
    if (totalBytes + input.blob.size > limits.maxTotalBytes) {
      throw new Error(`Model storage is limited to ${limits.maxTotalBytes} bytes`);
    }
    const blob = input.blob.slice(0, input.blob.size, "model/gltf-binary");
    const record: DirectorModelRecord = {
      ...safeIdentity,
      fileName,
      bytes: blob.size,
      mimeType: "model/gltf-binary",
      createdAt: new Date().toISOString(),
      blob,
    };
    await write(record);
    return copyRecord(record);
  };

  return {
    async list(ownerScope: string, projectId: string, directorNodeId: string): Promise<DirectorModelRecord[]> {
      const safeOwner = boundedId(ownerScope, "ownerScope");
      const safeProject = boundedId(projectId, "projectId");
      const safeDirector = boundedId(directorNodeId, "directorNodeId");
      const prefix = directorPrefix({ ownerScope: safeOwner, projectId: safeProject, directorNodeId: safeDirector });
      if (adapter === defaultAdapter) {
        return modelStore("readonly", async (store) => {
          const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
          const [keys, values] = await Promise.all([
            promisifyRequest(store.getAllKeys(range)),
            promisifyRequest(store.getAll(range)),
          ]);
          return values.flatMap((value, index) => {
            const record = normalizeRecord(value);
            return record && record.ownerScope === safeOwner && record.projectId === safeProject &&
              record.directorNodeId === safeDirector && keys[index] === keyFor(record) ? [copyRecord(record)] : [];
          });
        });
      }
      return (await all())
        .filter(({ record }) => record.ownerScope === safeOwner && record.projectId === safeProject && record.directorNodeId === safeDirector)
        .map(({ record }) => copyRecord(record));
    },

    async get(value: DirectorModelIdentity): Promise<DirectorModelRecord | null> {
      const safeIdentity = identity(value);
      if (adapter === defaultAdapter) {
        const record = normalizeRecord(await get(keyFor(safeIdentity), modelStore));
        return record && sameIdentity(record, safeIdentity) ? copyRecord(record) : null;
      }
      const match = (await all()).find(({ key, record }) => key === keyFor(safeIdentity) && sameIdentity(record, safeIdentity));
      return match ? copyRecord(match.record) : null;
    },

    async put(input: DirectorModelInput): Promise<DirectorModelRecord> {
      boundedFileName(input.fileName);
      if (!(input.blob instanceof Blob) || !["", "application/octet-stream", "model/gltf-binary"].includes(input.blob.type)) {
        throw new Error("GLB MIME type is unsupported");
      }
      if (input.blob.size > limits.maxBlobBytes) throw new Error(`GLB exceeds ${limits.maxBlobBytes} bytes`);
      await validateDirectorGlb(input.blob, { maxBlobBytes: limits.maxBlobBytes });
      if (adapter === defaultAdapter) {
        return withWriteLock(() => modelStore("readwrite", async (store) => {
          const [keys, values] = await Promise.all([
            promisifyRequest(store.getAllKeys()),
            promisifyRequest(store.getAll()),
          ]);
          const raw = keys.flatMap((key, index) => typeof key === "string"
            ? [[key, values[index]] as [string, unknown]]
            : []);
          const stored = normalizeEntries(raw);
          const validKeys = new Set(stored.map(({ key }) => key));
          await Promise.all(raw
            .map(([key]) => key)
            .filter((key) => key.startsWith("model:") && !validKeys.has(key))
            .map((key) => promisifyRequest(store.delete(key))));
          return commit(stored, input, async (record) => {
            await promisifyRequest(store.put(record, keyFor(record)));
          });
        }));
      }
      return withWriteLock(async () => commit(await all(true), input, async (record) => adapter.set(keyFor(record), record)));
    },

    async delete(value: DirectorModelIdentity): Promise<void> {
      const safeIdentity = identity(value);
      await withWriteLock(async () => adapter.delete(keyFor(safeIdentity)));
    },

    async prune(
      ownerScope: string,
      valid: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>,
      now = Date.now(),
    ): Promise<void> {
      boundedId(ownerScope, "ownerScope");
      const planPrune = (stored: Array<{ key: string; record: DirectorModelRecord }>) => {
        const owned = stored.filter(({ record }) => record.ownerScope === ownerScope);
        const deletes: string[] = [];
        const updates: DirectorModelRecord[] = [];
        for (const { key, record } of owned) {
          const directors = valid[record.projectId];
          if (!directors) {
            deletes.push(key);
            continue;
          }
          const objects = directors[record.directorNodeId];
          const active = objects?.[record.objectId] === record.assetId;
          if (active) {
            if (record.orphanedAt) updates.push({ ...record, orphanedAt: undefined });
          } else if (!record.orphanedAt) {
            updates.push({ ...record, orphanedAt: new Date(now).toISOString() });
          } else if (Date.parse(record.orphanedAt) <= now - ORPHAN_GRACE_MS) {
            deletes.push(key);
          }
        }
        return { deletes, updates };
      };
      await withWriteLock(async () => {
        if (adapter === defaultAdapter) {
          await modelStore("readwrite", async (store) => {
            const [keys, values] = await Promise.all([
              promisifyRequest(store.getAllKeys()),
              promisifyRequest(store.getAll()),
            ]);
            const raw = keys.flatMap((key, index) => typeof key === "string"
              ? [[key, values[index]] as [string, unknown]]
              : []);
            const stored = normalizeEntries(raw);
            const validKeys = new Set(stored.map(({ key }) => key));
            const { deletes, updates } = planPrune(stored);
            await Promise.all([
              ...raw.map(([key]) => key)
                .filter((key) => key.startsWith("model:") && !validKeys.has(key))
                .map((key) => promisifyRequest(store.delete(key))),
              ...deletes.map((key) => promisifyRequest(store.delete(key))),
              ...updates.map((record) => promisifyRequest(store.put(record, keyFor(record)))),
            ]);
          });
          return;
        }
        const { deletes, updates } = planPrune(await all(true));
        await Promise.all([
          ...deletes.map((key) => adapter.delete(key)),
          ...updates.map((record) => adapter.set(keyFor(record), record)),
        ]);
      });
    },
  };
}

export const directorModelStore = createDirectorModelStore();
