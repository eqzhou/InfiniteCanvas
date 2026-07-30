import { createStore, del, entries, get, promisifyRequest, set } from "idb-keyval";

import { validateDirectorGlb } from "@/lib/director-glb";
import { deleteBlob, getBlob, putBlob } from "@/services/storage";

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

type StoredDirectorModelBlob = {
  version: 1;
  mimeType: "model/gltf-binary";
  bytes: ArrayBuffer;
};

type StoredDirectorModelRecord = Omit<DirectorModelRecord, "blob"> & {
  blob: StoredDirectorModelBlob;
};

type DirectorModelMetadata = Omit<DirectorModelRecord, "blob">;

export type DirectorModelAdapter = {
  entries: () => Promise<Array<[string, unknown]>>;
  set: (key: string, value: unknown) => Promise<void>;
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

function normalizeRecordMetadata(value: unknown): DirectorModelMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<Omit<DirectorModelRecord, "blob"> & { blob: unknown }>;
  try {
    const identity: DirectorModelIdentity = {
      ownerScope: boundedId(input.ownerScope, "ownerScope"),
      projectId: boundedId(input.projectId, "projectId"),
      directorNodeId: boundedId(input.directorNodeId, "directorNodeId"),
      objectId: boundedId(input.objectId, "objectId"),
      assetId: boundedId(input.assetId, "assetId"),
    };
    const fileName = boundedFileName(input.fileName);
    if (input.mimeType !== "model/gltf-binary") return null;
    const payloadBytes = input.blob instanceof Blob && input.blob.type === input.mimeType
      ? input.blob.size
      : input.blob && typeof input.blob === "object" && !Array.isArray(input.blob)
        ? (() => {
            const stored = input.blob as Partial<StoredDirectorModelBlob>;
            return stored.version === 1 && stored.mimeType === "model/gltf-binary" && stored.bytes instanceof ArrayBuffer
              ? stored.bytes.byteLength
              : null;
          })()
        : null;
    if (payloadBytes === null || input.bytes !== payloadBytes ||
        input.bytes < 20 || input.bytes > DEFAULT_LIMITS.maxBlobBytes) return null;
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
      orphanedAt,
    };
  } catch {
    return null;
  }
}

function normalizeRecord(value: unknown): DirectorModelRecord | null {
  const metadata = normalizeRecordMetadata(value);
  if (!metadata || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = (value as { blob?: unknown }).blob;
  const blob = payload instanceof Blob
    ? payload
    : new Blob([(payload as StoredDirectorModelBlob).bytes], { type: "model/gltf-binary" });
  return { ...metadata, blob };
}

function storedRecord(record: DirectorModelRecord, bytes: ArrayBuffer): StoredDirectorModelRecord {
  return {
    ...record,
    blob: {
      version: 1,
      mimeType: "model/gltf-binary",
      bytes,
    },
  };
}

async function serializeRecord(record: DirectorModelRecord): Promise<StoredDirectorModelRecord> {
  return storedRecord(record, await record.blob.arrayBuffer());
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
    input: DirectorModelInput,
    usage: { count: number; totalBytes: number },
    write: (record: DirectorModelRecord) => Promise<void>,
  ): Promise<DirectorModelRecord> => {
    const safeIdentity = identity(input);
    const fileName = boundedFileName(input.fileName);
    if (usage.count >= limits.maxGlobal) throw new Error(`Model storage is limited to ${limits.maxGlobal} items`);
    if (usage.totalBytes + input.blob.size > limits.maxTotalBytes) {
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
      const { bytes: portableBytes } = await validateDirectorGlb(input.blob, { maxBlobBytes: limits.maxBlobBytes });
      if (adapter === defaultAdapter) {
        // Validation prepares bytes before opening the transaction. WebKit
        // auto-commits an IndexedDB transaction across an asynchronous Blob read.
        return withWriteLock(() => modelStore("readwrite", async (store) => {
          const targetKey = keyFor(identity(input));
          const usage = await new Promise<{ count: number; totalBytes: number }>((resolve, reject) => {
            let count = 0;
            let totalBytes = 0;
            const request = store.openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                resolve({ count, totalBytes });
                return;
              }
              const key = typeof cursor.key === "string" ? cursor.key : "";
              const metadata = normalizeRecordMetadata(cursor.value);
              if (key.startsWith("model:") && (!metadata || key !== keyFor(metadata))) {
                cursor.delete();
              } else if (metadata && key !== targetKey) {
                count += 1;
                totalBytes += metadata.bytes;
              }
              cursor.continue();
            };
          });
          return commit(input, usage, async (record) => {
            await promisifyRequest(store.put(storedRecord(record, portableBytes), keyFor(record)));
          });
        }));
      }
      return withWriteLock(async () => {
        const stored = await all(true);
        const targetKey = keyFor(identity(input));
        const others = stored.filter(({ key }) => key !== targetKey);
        return commit(
          input,
          {
            count: others.length,
            totalBytes: others.reduce((total, { record }) => total + record.bytes, 0),
          },
          async (record) => adapter.set(keyFor(record), storedRecord(record, portableBytes)),
        );
      });
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
          const legacyUpdates: DirectorModelRecord[] = [];
          await modelStore("readwrite", async (store) => {
            await new Promise<void>((resolve, reject) => {
              const request = store.openCursor();
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                  resolve();
                  return;
                }
                const key = typeof cursor.key === "string" ? cursor.key : "";
                const metadata = normalizeRecordMetadata(cursor.value);
                if (key.startsWith("model:") && (!metadata || key !== keyFor(metadata))) {
                  cursor.delete();
                  cursor.continue();
                  return;
                }
                if (!metadata || metadata.ownerScope !== ownerScope) {
                  cursor.continue();
                  return;
                }
                const directors = valid[metadata.projectId];
                const objects = directors?.[metadata.directorNodeId];
                const active = objects?.[metadata.objectId] === metadata.assetId;
                if (!directors || (!active && metadata.orphanedAt &&
                    Date.parse(metadata.orphanedAt) <= now - ORPHAN_GRACE_MS)) {
                  cursor.delete();
                } else if (active && metadata.orphanedAt) {
                  const payload = (cursor.value as { blob?: unknown }).blob;
                  if (payload instanceof Blob) {
                    legacyUpdates.push({ ...metadata, blob: payload, orphanedAt: undefined });
                  } else {
                    cursor.update({ ...(cursor.value as object), orphanedAt: undefined });
                  }
                } else if (!active && !metadata.orphanedAt) {
                  const orphanedAt = new Date(now).toISOString();
                  const payload = (cursor.value as { blob?: unknown }).blob;
                  if (payload instanceof Blob) {
                    legacyUpdates.push({ ...metadata, blob: payload, orphanedAt });
                  } else {
                    cursor.update({ ...(cursor.value as object), orphanedAt });
                  }
                }
                cursor.continue();
              };
            });
          });
          // Blob reads cannot occur inside the cursor transaction on WebKit.
          // Migrate changed legacy records one at a time after it closes.
          for (const record of legacyUpdates) {
            await defaultAdapter.set(keyFor(record), await serializeRecord(record));
          }
          return;
        }
        const { deletes, updates } = planPrune(await all(true));
        await Promise.all([
          ...deletes.map((key) => adapter.delete(key)),
          ...updates.map(async (record) => adapter.set(keyFor(record), await serializeRecord(record))),
        ]);
      });
    },
  };
}

type ServerDirectorModelDescriptor = DirectorModelIdentity & Pick<DirectorModelRecord, "fileName" | "bytes">;

function serverModelStorageKey(assetId: string): string {
  return `director-model:${boundedId(assetId, "assetId")}`;
}

/**
 * Runtime director models use the same authenticated protected-blob service as
 * canvas media. Their descriptors live in the PostgreSQL project document, so
 * a second browser metadata database is neither necessary nor authoritative.
 */
export const directorModelStore = {
  async list(
    ownerScope: string,
    projectId: string,
    directorNodeId: string,
    descriptors: readonly ServerDirectorModelDescriptor[] = [],
  ): Promise<DirectorModelRecord[]> {
    const scope = boundedId(ownerScope, "ownerScope");
    const project = boundedId(projectId, "projectId");
    const director = boundedId(directorNodeId, "directorNodeId");
    const records = await Promise.all(descriptors.map(async (descriptor) => {
      const safe = {
        ownerScope: boundedId(descriptor.ownerScope, "ownerScope"),
        projectId: boundedId(descriptor.projectId, "projectId"),
        directorNodeId: boundedId(descriptor.directorNodeId, "directorNodeId"),
        objectId: boundedId(descriptor.objectId, "objectId"),
        assetId: boundedId(descriptor.assetId, "assetId"),
      };
      if (safe.ownerScope !== scope || safe.projectId !== project || safe.directorNodeId !== director) return null;
      const fileName = boundedFileName(descriptor.fileName);
      if (!Number.isInteger(descriptor.bytes) || descriptor.bytes < 20 || descriptor.bytes > DEFAULT_LIMITS.maxBlobBytes) return null;
      const blob = await getBlob("media", serverModelStorageKey(safe.assetId));
      if (!blob || blob.size !== descriptor.bytes) return null;
      return {
        ...safe,
        fileName,
        bytes: blob.size,
        mimeType: "model/gltf-binary" as const,
        createdAt: new Date(0).toISOString(),
        blob: blob.slice(0, blob.size, "model/gltf-binary"),
      };
    }));
    return records.filter((record): record is DirectorModelRecord => record !== null);
  },

  async get(_value: DirectorModelIdentity): Promise<DirectorModelRecord | null> {
    return null;
  },

  async put(input: DirectorModelInput): Promise<DirectorModelRecord> {
    const safeIdentity: DirectorModelIdentity = {
      ownerScope: boundedId(input.ownerScope, "ownerScope"),
      projectId: boundedId(input.projectId, "projectId"),
      directorNodeId: boundedId(input.directorNodeId, "directorNodeId"),
      objectId: boundedId(input.objectId, "objectId"),
      assetId: boundedId(input.assetId, "assetId"),
    };
    const fileName = boundedFileName(input.fileName);
    const { bytes } = await validateDirectorGlb(input.blob, { maxBlobBytes: DEFAULT_LIMITS.maxBlobBytes });
    const stored = new Blob([bytes], { type: "application/octet-stream" });
    await putBlob("media", serverModelStorageKey(safeIdentity.assetId), stored);
    return {
      ...safeIdentity,
      fileName,
      bytes: stored.size,
      mimeType: "model/gltf-binary",
      createdAt: new Date().toISOString(),
      blob: stored.slice(0, stored.size, "model/gltf-binary"),
    };
  },

  async delete(value: DirectorModelIdentity): Promise<void> {
    await deleteBlob("media", serverModelStorageKey(value.assetId));
  },

  async prune(
    _ownerScope: string,
    _valid: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>,
    _now = Date.now(),
  ): Promise<void> {
    // Project descriptors are authoritative. Explicit model removal and failed
    // imports delete their blob immediately; tenant quota remains server-side.
  },
};
