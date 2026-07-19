import type {
  AppConfig,
  AssetItem,
  BoardProject,
  GenerationJob,
  PromptItem,
} from "@/types/board";
import { parseBoardProject } from "@/lib/board-document";
import { createZipStore, readZipStore, type ZipStoreInput } from "@/lib/zip-store";
import { validateJsonObject } from "@/lib/bounded-json";
import { normalizeAppConfig } from "@/lib/app-config";
import { buildBackupBundle, mergeBackupConfig, type BackupConfig } from "@/services/webdav";
import { validateGenerationJob } from "@/services/generation-jobs";
import { deleteBlob, getBlob, storeImportedMedia } from "@/services/storage";

type MediaKind = "image" | "media";

type BundleMedia = {
  id: string;
  entry: string;
  storageKey: string;
  kind: MediaKind;
  mimeType: string;
  bytes: number;
};

type WorkspaceManifest = {
  format: "openboard.workspace-bundle";
  version: 1;
  exportedAt: string;
  media: BundleMedia[];
};

export type WorkspaceSnapshot = {
  projects: BoardProject[];
  assets: AssetItem[];
  prompts: PromptItem[];
  config: AppConfig;
  generationJobs: GenerationJob[];
};

type WorkspaceDocument = Omit<WorkspaceSnapshot, "config"> & {
  version: 1;
  exportedAt: string;
  config: BackupConfig;
};

export type WorkspaceBundleStorage = {
  load: (kind: MediaKind, storageKey: string) => Promise<Blob | undefined>;
  store: (kind: MediaKind, blob: Blob) => Promise<{ storageKey: string; url: string }>;
  remove: (kind: MediaKind, storageKey: string) => Promise<void>;
};

const defaultStorage: WorkspaceBundleStorage = {
  load: getBlob,
  store: storeImportedMedia,
  remove: deleteBlob,
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function decodeJSON(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function kindForKey(storageKey: string): MediaKind {
  return storageKey.startsWith("media:") ? "media" : "image";
}

function collectProjectKeys(project: BoardProject, keys: Set<string>): void {
  for (const node of project.nodes) {
    if (node.metadata.storageKey) keys.add(node.metadata.storageKey);
    for (const key of node.metadata.referenceStorageKeys ?? []) keys.add(key);
  }
  for (const session of project.chatSessions) {
    for (const message of session.messages) {
      for (const image of message.images ?? []) if (image.storageKey) keys.add(image.storageKey);
      for (const reference of message.references ?? []) {
        if (reference.storageKey) keys.add(reference.storageKey);
      }
    }
  }
}

function collectKeys(snapshot: WorkspaceSnapshot): string[] {
  const keys = new Set<string>();
  for (const project of snapshot.projects) collectProjectKeys(project, keys);
  for (const asset of snapshot.assets) if (asset.storageKey) keys.add(asset.storageKey);
  for (const job of snapshot.generationJobs) {
    const references = job.parameters.referenceStorageKeys;
    if (Array.isArray(references)) {
      for (const key of references) if (typeof key === "string") keys.add(key);
    }
    const items = job.result.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && typeof item === "object" &&
            typeof (item as { storageKey?: unknown }).storageKey === "string") {
          keys.add((item as { storageKey: string }).storageKey);
        }
      }
    }
  }
  return [...keys];
}

function placeholder(key: string | undefined, mediaByKey: Map<string, BundleMedia>): string | undefined {
  if (!key) return undefined;
  const media = mediaByKey.get(key);
  if (!media) throw new Error(`Workspace media declaration is missing: ${key}`);
  return `obundle://${media.id}`;
}

function canonicalize(snapshot: WorkspaceSnapshot, mediaByKey: Map<string, BundleMedia>): WorkspaceSnapshot {
  const copy = structuredClone(snapshot);
  for (const project of copy.projects) {
    for (const node of project.nodes) {
      if (node.metadata.storageKey) node.metadata.content = placeholder(node.metadata.storageKey, mediaByKey);
    }
    for (const session of project.chatSessions) {
      for (const message of session.messages) {
        for (const image of message.images ?? []) {
          if (image.storageKey) image.url = placeholder(image.storageKey, mediaByKey)!;
        }
        for (const reference of message.references ?? []) {
          if (reference.storageKey) reference.preview = placeholder(reference.storageKey, mediaByKey);
        }
      }
    }
  }
  for (const asset of copy.assets) {
    if (asset.storageKey) asset.coverUrl = placeholder(asset.storageKey, mediaByKey);
  }
  for (const job of copy.generationJobs) {
    const items = job.result.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const result = item as { storageKey?: unknown; url?: unknown };
      if (typeof result.storageKey === "string") {
        result.url = placeholder(result.storageKey, mediaByKey);
      }
    }
  }
  return copy;
}

export async function exportWorkspaceBundle(
  snapshot: WorkspaceSnapshot,
  storage: WorkspaceBundleStorage = defaultStorage,
): Promise<Blob> {
  const media: BundleMedia[] = [];
  const objects: ZipStoreInput[] = [];
  for (const [index, storageKey] of collectKeys(snapshot).entries()) {
    const kind = kindForKey(storageKey);
    const blob = await storage.load(kind, storageKey);
    if (!blob) throw new Error(`Referenced workspace media is missing: ${storageKey}`);
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
    objects.push({ name: entry, data: blob });
  }
  const mediaByKey = new Map(media.map((item) => [item.storageKey, item]));
  const canonical = canonicalize(snapshot, mediaByKey);
  const backup = buildBackupBundle(canonical);
  const exportedAt = new Date().toISOString();
  const manifest: WorkspaceManifest = {
    format: "openboard.workspace-bundle",
    version: 1,
    exportedAt,
    media,
  };
  const workspace: WorkspaceDocument = {
    version: 1,
    exportedAt,
    projects: backup.projects,
    assets: backup.assets,
    prompts: backup.prompts,
    config: backup.config,
    generationJobs: canonical.generationJobs,
  };
  return createZipStore([
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "workspace.json", data: JSON.stringify(workspace, null, 2) },
    ...objects,
  ]);
}

function parseManifest(value: unknown): WorkspaceManifest {
  const input = record(value, "Workspace manifest");
  if (input.format !== "openboard.workspace-bundle" || input.version !== 1 ||
      typeof input.exportedAt !== "string" || Number.isNaN(Date.parse(input.exportedAt)) ||
      !Array.isArray(input.media) || input.media.length > 10_000) {
    throw new Error("Invalid workspace manifest");
  }
  const ids = new Set<string>();
  const entries = new Set<string>();
  const storageKeys = new Set<string>();
  const media = input.media.map((raw, index): BundleMedia => {
    const item = record(raw, `Workspace media ${index}`);
    const id = boundedString(item.id, `Workspace media ${index} id`, 64);
    const entry = boundedString(item.entry, `Workspace media ${index} entry`, 256);
    const storageKey = boundedString(item.storageKey, `Workspace media ${index} storageKey`, 512);
    const mimeType = boundedString(item.mimeType, `Workspace media ${index} mimeType`, 256);
    const kind = item.kind;
    const bytes = item.bytes;
    if (!/^media-[1-9][0-9]*$/.test(id) || entry !== `objects/${id}.bin` ||
        !storageKey || (kind !== "image" && kind !== "media") ||
        typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 ||
        ids.has(id) || entries.has(entry) || storageKeys.has(storageKey)) {
      throw new Error(`Invalid workspace media ${index}`);
    }
    ids.add(id);
    entries.add(entry);
    storageKeys.add(storageKey);
    return { id, entry, storageKey, kind, mimeType, bytes };
  });
  return {
    format: "openboard.workspace-bundle",
    version: 1,
    exportedAt: input.exportedAt,
    media,
  };
}

function parseAsset(value: unknown, index: number): AssetItem {
  const input = record(value, `Workspace asset ${index}`);
  const id = boundedString(input.id, `Workspace asset ${index} id`, 128);
  const kind = input.kind;
  if (!ID.test(id) || (kind !== "text" && kind !== "image" && kind !== "video" && kind !== "audio") ||
      !Array.isArray(input.tags) || input.tags.length > 50 ||
      input.tags.some((tag) => typeof tag !== "string" || tag.length > 100)) {
    throw new Error(`Invalid workspace asset ${index}`);
  }
  boundedString(input.title, `Workspace asset ${index} title`, 500);
  boundedString(input.createdAt, `Workspace asset ${index} createdAt`, 64);
  boundedString(input.updatedAt, `Workspace asset ${index} updatedAt`, 64);
  for (const [key, max] of [["notes", 100_000], ["source", 1_000], ["content", 1_000_000],
    ["coverUrl", 2_000], ["storageKey", 512], ["mimeType", 256]] as const) {
    if (input[key] !== undefined) boundedString(input[key], `Workspace asset ${index} ${key}`, max);
  }
  return structuredClone(input) as AssetItem;
}

function parsePrompt(value: unknown, index: number): PromptItem {
  const input = record(value, `Workspace prompt ${index}`);
  const id = boundedString(input.id, `Workspace prompt ${index} id`, 128);
  if (!ID.test(id) || !Array.isArray(input.tags) || input.tags.length > 50 ||
      input.tags.some((tag) => typeof tag !== "string" || tag.length > 100)) {
    throw new Error(`Invalid workspace prompt ${index}`);
  }
  boundedString(input.title, `Workspace prompt ${index} title`, 500);
  boundedString(input.body, `Workspace prompt ${index} body`, 100_000);
  boundedString(input.source, `Workspace prompt ${index} source`, 1_000);
  if (input.sourceId !== undefined) {
    const sourceId = boundedString(input.sourceId, `Workspace prompt ${index} sourceId`, 64);
    if (!ID.test(sourceId)) throw new Error(`Invalid workspace prompt ${index} sourceId`);
  }
  if (input.coverUrl !== undefined) boundedString(input.coverUrl, `Workspace prompt ${index} coverUrl`, 2_000);
  if (input.resultUrls !== undefined && (!Array.isArray(input.resultUrls) || input.resultUrls.length > 100 ||
      input.resultUrls.some((url) => typeof url !== "string" || url.length > 2_000))) {
    throw new Error(`Invalid workspace prompt ${index} resultUrls`);
  }
  return structuredClone(input) as PromptItem;
}

function parseWorkspace(value: unknown, localConfig: AppConfig): WorkspaceSnapshot {
  validateJsonObject(value, {
    label: "workspace document",
    maxBytes: 64 * 1024 * 1024,
    maxDepth: 50,
    maxEntries: 500_000,
  });
  const input = record(value, "Workspace document");
  if (input.version !== 1 || typeof input.exportedAt !== "string" ||
      Number.isNaN(Date.parse(input.exportedAt)) || !Array.isArray(input.projects) ||
      !Array.isArray(input.assets) || !Array.isArray(input.prompts) ||
      !Array.isArray(input.generationJobs) || input.projects.length > 10_000 ||
      input.assets.length > 100_000 || input.prompts.length > 100_000 ||
      input.generationJobs.length > 10_000) {
    throw new Error("Invalid workspace document");
  }
  const config = record(input.config, "Workspace config");
  if (!Array.isArray(config.channels) || config.channels.length > 100) {
    throw new Error("Invalid workspace config");
  }
  const projects = input.projects.map((project) => parseBoardProject(project));
  const assets = input.assets.map(parseAsset);
  const prompts = input.prompts.map(parsePrompt);
  const generationJobs = input.generationJobs.map((job, index) => {
    try {
      return validateGenerationJob(structuredClone(record(job, `Workspace generation job ${index}`)) as GenerationJob);
    } catch {
      throw new Error(`Invalid workspace generation job ${index}`);
    }
  });
  for (const [values, label] of [[projects, "project"], [assets, "asset"], [prompts, "prompt"],
    [generationJobs, "generation job"]] as const) {
    const ids = new Set<string>();
    for (const item of values) {
      if (ids.has(item.id)) throw new Error(`Duplicate workspace ${label} id`);
      ids.add(item.id);
    }
  }
  return {
    projects,
    assets,
    prompts,
    generationJobs,
    config: normalizeAppConfig(mergeBackupConfig(localConfig, config as BackupConfig)),
  };
}

function remap(snapshot: WorkspaceSnapshot, replacements: Map<string, { storageKey: string; url: string }>): WorkspaceSnapshot {
  const copy = structuredClone(snapshot);
  const replace = (key: string | undefined) => {
    if (!key) return undefined;
    const replacement = replacements.get(key);
    if (!replacement) throw new Error(`Workspace media declaration is missing: ${key}`);
    return replacement;
  };
  for (const project of copy.projects) {
    for (const node of project.nodes) {
      const replacement = replace(node.metadata.storageKey);
      if (replacement) {
        node.metadata.storageKey = replacement.storageKey;
        node.metadata.content = replacement.url;
      }
      node.metadata.referenceStorageKeys = node.metadata.referenceStorageKeys?.map((key) =>
        replace(key)!.storageKey);
    }
    for (const session of project.chatSessions) {
      for (const message of session.messages) {
        for (const image of message.images ?? []) {
          const replacement = replace(image.storageKey);
          if (replacement) {
            image.storageKey = replacement.storageKey;
            image.url = replacement.url;
          }
        }
        for (const reference of message.references ?? []) {
          const replacement = replace(reference.storageKey);
          if (replacement) {
            reference.storageKey = replacement.storageKey;
            reference.preview = replacement.url;
          }
        }
      }
    }
  }
  for (const asset of copy.assets) {
    const replacement = replace(asset.storageKey);
    if (replacement) {
      asset.storageKey = replacement.storageKey;
      asset.coverUrl = replacement.url;
    }
  }
  for (const job of copy.generationJobs) {
    const references = job.parameters.referenceStorageKeys;
    if (Array.isArray(references)) {
      job.parameters.referenceStorageKeys = references.map((key) =>
        typeof key === "string" ? replace(key)!.storageKey : key);
    }
    const items = job.result.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const result = item as { storageKey?: unknown; url?: unknown };
      if (typeof result.storageKey !== "string") continue;
      const replacement = replace(result.storageKey)!;
      result.storageKey = replacement.storageKey;
      result.url = replacement.url;
    }
  }
  return copy;
}

export async function importWorkspaceBundle(
  source: Blob | ArrayBuffer | Uint8Array,
  localConfig: AppConfig,
  storage: WorkspaceBundleStorage = defaultStorage,
  apply?: (snapshot: WorkspaceSnapshot) => Promise<void>,
): Promise<WorkspaceSnapshot> {
  const entries = await readZipStore(source);
  const manifestBytes = entries.get("manifest.json");
  const workspaceBytes = entries.get("workspace.json");
  if (!manifestBytes || !workspaceBytes) throw new Error("Workspace manifest or document is missing");
  const manifest = parseManifest(decodeJSON(manifestBytes, "workspace manifest"));
  const snapshot = parseWorkspace(decodeJSON(workspaceBytes, "workspace document"), localConfig);
  const declaredEntries = new Set([
    "manifest.json",
    "workspace.json",
    ...manifest.media.map((item) => item.entry),
  ]);
  for (const name of entries.keys()) {
    if (!declaredEntries.has(name)) throw new Error(`Workspace contains undeclared entry: ${name}`);
  }
  if (entries.size !== declaredEntries.size) throw new Error("Workspace is missing a declared entry");
  const keys = new Set(collectKeys(snapshot));
  const manifestKeys = new Set(manifest.media.map((item) => item.storageKey));
  if (keys.size !== manifestKeys.size || [...keys].some((key) => !manifestKeys.has(key))) {
    throw new Error("Workspace media references do not match the manifest");
  }

  const replacements = new Map<string, { storageKey: string; url: string }>();
  const stored: Array<{ kind: MediaKind; storageKey: string }> = [];
  try {
    for (const item of manifest.media) {
      const bytes = entries.get(item.entry);
      if (!bytes || bytes.byteLength !== item.bytes) {
        throw new Error(`Workspace media size mismatch: ${item.entry}`);
      }
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const replacement = await storage.store(
        item.kind,
        new Blob([buffer], { type: item.mimeType }),
      );
      replacements.set(item.storageKey, replacement);
      stored.push({ kind: item.kind, storageKey: replacement.storageKey });
    }
    const restored = remap(snapshot, replacements);
    await apply?.(restored);
    return restored;
  } catch (error) {
    await Promise.allSettled(stored.map((item) => storage.remove(item.kind, item.storageKey)));
    throw error;
  }
}
