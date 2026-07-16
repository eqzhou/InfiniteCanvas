import type { BoardProject } from "@/types/board";
import { parseBoardProject } from "@/lib/board-document";
import { createZipStore, readZipStore, type ZipStoreInput } from "@/lib/zip-store";
import { deleteBlob, getBlob, uploadMedia } from "@/services/storage";

type MediaKind = "image" | "media";

type BundleMedia = {
  id: string;
  entry: string;
  storageKey: string;
  kind: MediaKind;
  mimeType: string;
  bytes: number;
};

type ProjectBundleManifest = {
  format: "openboard.project-bundle";
  version: 1;
  exportedAt: string;
  media: BundleMedia[];
};

export type ProjectBundleStorage = {
  load: (kind: MediaKind, storageKey: string) => Promise<Blob | undefined>;
  store: (kind: MediaKind, blob: Blob) => Promise<{ storageKey: string; url: string }>;
  remove: (kind: MediaKind, storageKey: string) => Promise<void>;
};

const defaultStorage: ProjectBundleStorage = {
  load: getBlob,
  store: async (kind, blob) => {
    const result = await uploadMedia(blob, kind);
    return { storageKey: result.storageKey, url: result.url };
  },
  remove: deleteBlob,
};

const decoder = new TextDecoder("utf-8", { fatal: true });

function kindForStorageKey(storageKey: string): MediaKind {
  return storageKey.startsWith("media:") ? "media" : "image";
}

function collectProjectKeys(project: BoardProject): string[] {
  const keys = new Set<string>();
  for (const node of project.nodes) {
    if (node.metadata.storageKey) keys.add(node.metadata.storageKey);
  }
  for (const session of project.chatSessions) {
    for (const message of session.messages) {
      for (const image of message.images ?? []) {
        if (image.storageKey) keys.add(image.storageKey);
      }
      for (const reference of message.references ?? []) {
        if (reference.storageKey) keys.add(reference.storageKey);
      }
    }
  }
  return [...keys];
}

function canonicalProject(project: BoardProject, mediaByKey: Map<string, BundleMedia>): BoardProject {
  const copy = structuredClone(project);
  for (const node of copy.nodes) {
    const key = node.metadata.storageKey;
    if (key) node.metadata.content = `obundle://${mediaByKey.get(key)?.id}`;
  }
  for (const session of copy.chatSessions) {
    for (const message of session.messages) {
      for (const image of message.images ?? []) {
        if (image.storageKey) image.url = `obundle://${mediaByKey.get(image.storageKey)?.id}`;
      }
      for (const reference of message.references ?? []) {
        if (reference.storageKey) {
          reference.preview = `obundle://${mediaByKey.get(reference.storageKey)?.id}`;
        }
      }
    }
  }
  return copy;
}

export async function exportProjectBundle(
  project: BoardProject,
  storage: ProjectBundleStorage = defaultStorage,
): Promise<Blob> {
  const media: BundleMedia[] = [];
  const entries: ZipStoreInput[] = [];
  for (const [index, storageKey] of collectProjectKeys(project).entries()) {
    const kind = kindForStorageKey(storageKey);
    const blob = await storage.load(kind, storageKey);
    if (!blob) throw new Error(`Referenced media is missing: ${storageKey}`);
    const id = `media-${index + 1}`;
    const entry = `objects/${id}.bin`;
    media.push({
      id,
      entry,
      storageKey,
      kind,
      mimeType: blob.type || "application/octet-stream",
      bytes: blob.size,
    });
    entries.push({ name: entry, data: blob });
  }

  const mediaByKey = new Map(media.map((item) => [item.storageKey, item]));
  const manifest: ProjectBundleManifest = {
    format: "openboard.project-bundle",
    version: 1,
    exportedAt: new Date().toISOString(),
    media,
  };
  return createZipStore([
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "project.json", data: JSON.stringify(canonicalProject(project, mediaByKey), null, 2) },
    ...entries,
  ]);
}

function decodeJSON(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}

function parseManifest(value: unknown): ProjectBundleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid bundle manifest");
  }
  const input = value as Record<string, unknown>;
  if (input.format !== "openboard.project-bundle" || input.version !== 1) {
    throw new Error("Unsupported bundle format or version");
  }
  if (typeof input.exportedAt !== "string" || !Array.isArray(input.media)) {
    throw new Error("Invalid bundle manifest");
  }
  const ids = new Set<string>();
  const entries = new Set<string>();
  const storageKeys = new Set<string>();
  const media = input.media.map((value, index): BundleMedia => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid bundle media item ${index}`);
    }
    const item = value as Record<string, unknown>;
    const id = item.id;
    const entry = item.entry;
    const storageKey = item.storageKey;
    const kind = item.kind;
    const mimeType = item.mimeType;
    const bytes = item.bytes;
    if (
      typeof id !== "string" || !/^media-[1-9][0-9]*$/.test(id) ||
      typeof entry !== "string" || entry !== `objects/${id}.bin` ||
      typeof storageKey !== "string" || !storageKey ||
      (kind !== "image" && kind !== "media") ||
      typeof mimeType !== "string" || mimeType.length > 256 ||
      typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0
    ) {
      throw new Error(`Invalid bundle media item ${index}`);
    }
    if (ids.has(id) || entries.has(entry) || storageKeys.has(storageKey)) {
      throw new Error("Duplicate bundle media declaration");
    }
    ids.add(id);
    entries.add(entry);
    storageKeys.add(storageKey);
    return { id, entry, storageKey, kind, mimeType, bytes };
  });
  if (media.length > 10_000) throw new Error("Bundle contains too many media items");
  return {
    format: "openboard.project-bundle",
    version: 1,
    exportedAt: input.exportedAt,
    media,
  };
}

function remapProject(
  project: BoardProject,
  replacements: Map<string, { storageKey: string; url: string }>,
): BoardProject {
  const copy = structuredClone(project);
  const replace = (storageKey: string | undefined) => {
    if (!storageKey) return undefined;
    const result = replacements.get(storageKey);
    if (!result) throw new Error(`Bundle media declaration is missing: ${storageKey}`);
    return result;
  };
  for (const node of copy.nodes) {
    const result = replace(node.metadata.storageKey);
    if (result) {
      node.metadata.storageKey = result.storageKey;
      node.metadata.content = result.url;
    }
  }
  for (const session of copy.chatSessions) {
    for (const message of session.messages) {
      for (const image of message.images ?? []) {
        const result = replace(image.storageKey);
        if (result) {
          image.storageKey = result.storageKey;
          image.url = result.url;
        }
      }
      for (const reference of message.references ?? []) {
        const result = replace(reference.storageKey);
        if (result) {
          reference.storageKey = result.storageKey;
          reference.preview = result.url;
        }
      }
    }
  }
  return copy;
}

export async function importProjectBundle(
  source: Blob | ArrayBuffer | Uint8Array,
  storage: ProjectBundleStorage = defaultStorage,
): Promise<BoardProject> {
  const entries = await readZipStore(source);
  const manifestBytes = entries.get("manifest.json");
  const projectBytes = entries.get("project.json");
  if (!manifestBytes || !projectBytes) throw new Error("Bundle manifest or project is missing");
  const manifest = parseManifest(decodeJSON(manifestBytes, "bundle manifest"));
  const project = parseBoardProject(decodeJSON(projectBytes, "project document"));

  const declaredEntries = new Set([
    "manifest.json",
    "project.json",
    ...manifest.media.map((item) => item.entry),
  ]);
  for (const name of entries.keys()) {
    if (!declaredEntries.has(name)) throw new Error(`Bundle contains undeclared entry: ${name}`);
  }
  if (entries.size !== declaredEntries.size) throw new Error("Bundle is missing a declared entry");

  const projectKeys = new Set(collectProjectKeys(project));
  const manifestKeys = new Set(manifest.media.map((item) => item.storageKey));
  if (
    projectKeys.size !== manifestKeys.size ||
    [...projectKeys].some((key) => !manifestKeys.has(key))
  ) {
    throw new Error("Bundle project media references do not match the manifest");
  }

  const replacements = new Map<string, { storageKey: string; url: string }>();
  const stored: Array<{ kind: MediaKind; storageKey: string }> = [];
  try {
    for (const item of manifest.media) {
      const data = entries.get(item.entry);
      if (!data || data.byteLength !== item.bytes) {
        throw new Error(`Bundle media size mismatch: ${item.entry}`);
      }
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      const result = await storage.store(
        item.kind,
        new Blob([buffer], { type: item.mimeType }),
      );
      replacements.set(item.storageKey, result);
      stored.push({ kind: item.kind, storageKey: result.storageKey });
    }
    return remapProject(project, replacements);
  } catch (error) {
    await Promise.allSettled(
      stored.map((item) => storage.remove(item.kind, item.storageKey)),
    );
    throw error;
  }
}
