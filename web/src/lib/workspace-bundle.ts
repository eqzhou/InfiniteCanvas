import type {
  AppConfig,
  AssetItem,
  BoardProject,
  GenerationJob,
  PromptItem,
} from "@/types/board";
import type { FilmDocument } from "@/types/film";
import type { WorkflowTemplate, WorkflowValues, WorkflowRunResult } from "@/types/workflow";
import { parseBoardProject } from "@/lib/board-document";
import { createZipStore, readZipStore, type ZipStoreInput } from "@/lib/zip-store";
import { validateJsonObject } from "@/lib/bounded-json";
import { normalizeAppConfig } from "@/lib/app-config";
import { buildBackupBundle, mergeBackupConfig, type BackupConfig } from "@/services/webdav";
import {
  collectGenerationStorageKeysFromJobs,
  validateGenerationJob,
} from "@/services/generation-jobs";
import { parseWorkflowTemplate } from "@/lib/workflow-document";
import { parseWorkflowRunParameters, parseWorkflowRunResult } from "@/lib/workflow-job";
import { deleteBlob, getBlob, storeImportedMedia } from "@/services/storage";
import {
  readPanoramaBlobDimensions,
  validatePanoramaBlob,
  validatePanoramaDimensions,
  validateProjectPanoramaBudget,
} from "@/lib/panorama";
import { assertBundlePanoramaMediaManaged } from "@/lib/plain-project-import";
import { parseBundleFilm } from "@/lib/project-bundle";

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
  workflowTemplates: WorkflowTemplate[];
  films?: FilmDocument[];
};

export class WorkspaceReplacementRollbackError extends AggregateError {
  constructor(commitError: unknown, rollbackError: unknown) {
    super([commitError, rollbackError], "Workspace replacement failed and rollback is incomplete");
    this.name = "WorkspaceReplacementRollbackError";
  }
}

type WorkspaceDocument = Omit<WorkspaceSnapshot, "config"> & {
  version: 3;
  exportedAt: string;
  config: BackupConfig;
};

export type WorkspaceBundleStorage = {
  load: (kind: MediaKind, storageKey: string) => Promise<Blob | undefined>;
  store: (kind: MediaKind, blob: Blob) => Promise<{
    storageKey: string;
    url: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
  }>;
  remove: (kind: MediaKind, storageKey: string) => Promise<void>;
};
type StoredWorkspaceMedia = Awaited<ReturnType<WorkspaceBundleStorage["store"]>>;

export type ImportedWorkspaceMedia = {
  storageKey: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  objectVersion: string;
};

export type WorkspaceImportContext = {
  media: ImportedWorkspaceMedia[];
  cleanupMigrated: (storageKeys: readonly string[]) => Promise<void>;
};

async function digestHex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function importedMediaIdentity(bytes: Uint8Array, mimeType: string): Promise<{ sha256: string; objectVersion: string }> {
  const prefix = new TextEncoder().encode(`${mimeType}\0`);
  const versionBytes = new Uint8Array(prefix.length + bytes.length);
  versionBytes.set(prefix); versionBytes.set(bytes, prefix.length);
  return { sha256: await digestHex(bytes), objectVersion: `m1-${await digestHex(versionBytes)}` };
}

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
  return storageKey.startsWith("image:") ? "image" : "media";
}

function isFilmStorageKey(value: string): boolean {
  return value.startsWith("image:") || value.startsWith("media:") || value.startsWith("film:");
}

const filmShotMediaFields = ["imageStorageKey", "firstFrameStorageKey", "videoStorageKey", "audioStorageKey"] as const;

function collectFilmAssetKey(asset: FilmDocument["assets"][number] | undefined, keys: Set<string>): void {
  if (asset?.mediaStorageKey) keys.add(asset.mediaStorageKey);
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
  for (const key of collectGenerationStorageKeysFromJobs(snapshot.generationJobs)) keys.add(key);
  for (const film of snapshot.films ?? []) {
    for (const shot of film.shots) {
      if (shot.imageStorageKey) keys.add(shot.imageStorageKey);
      if (shot.firstFrameStorageKey) keys.add(shot.firstFrameStorageKey);
      if (shot.videoStorageKey) keys.add(shot.videoStorageKey);
      if (shot.audioStorageKey) keys.add(shot.audioStorageKey);
    }
    for (const asset of film.assets) collectFilmAssetKey(asset, keys);
    for (const dialogue of film.dialogues ?? []) if (dialogue.audioStorageKey) keys.add(dialogue.audioStorageKey);
    for (const task of film.tasks) {
      for (const asset of task.snapshot?.identityVersions ?? []) collectFilmAssetKey(asset, keys);
      collectFilmAssetKey(task.snapshot?.styleVersion, keys);
      for (const key of task.snapshot?.referenceStorageKeys ?? []) keys.add(key);
    }
    for (const track of film.timeline.tracks) for (const clip of track.clips) if (isFilmStorageKey(clip.source)) keys.add(clip.source);
    for (const deliverable of film.deliverables) if (deliverable.storageKey) keys.add(deliverable.storageKey);
    for (const version of film.versions ?? []) if (version.entityType === "shot") for (const field of filmShotMediaFields) {
      const key = version.snapshot[field];
      if (typeof key === "string") keys.add(key);
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
    version: 3,
    exportedAt,
    projects: backup.projects,
    assets: backup.assets,
    prompts: backup.prompts,
    config: backup.config,
    generationJobs: canonical.generationJobs,
    workflowTemplates: canonical.workflowTemplates,
    films: canonical.films ?? [],
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
  if ((input.version !== 1 && input.version !== 2 && input.version !== 3) || typeof input.exportedAt !== "string" ||
      Number.isNaN(Date.parse(input.exportedAt)) || !Array.isArray(input.projects) ||
      !Array.isArray(input.assets) || !Array.isArray(input.prompts) ||
      !Array.isArray(input.generationJobs) || input.projects.length > 10_000 ||
      input.assets.length > 100_000 || input.prompts.length > 100_000 ||
      input.generationJobs.length > 10_000) {
    throw new Error("Invalid workspace document");
  }
  if (input.version === 1 && input.workflowTemplates !== undefined) {
    throw new Error("A v1 workspace cannot contain workflow templates");
  }
  const config = record(input.config, "Workspace config");
  if (!Array.isArray(config.channels) || config.channels.length > 100) {
    throw new Error("Invalid workspace config");
  }
  const projects = input.projects.map((project) => parseBoardProject(project));
  if (input.version !== 3 && input.films !== undefined) throw new Error("A legacy workspace cannot contain film payloads");
  const rawFilms = input.version === 3 ? input.films : [];
  if (!Array.isArray(rawFilms) || rawFilms.length > 10_000) throw new Error("Invalid workspace films");
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const films = rawFilms.map((film, index) => {
    const projectId = film && typeof film === "object" && !Array.isArray(film)
      ? (film as { projectId?: unknown }).projectId
      : undefined;
    if (typeof projectId !== "string" || projectsById.get(projectId)?.projectKind !== "film") {
      throw new Error(`Invalid workspace film ${index}`);
    }
    return parseBundleFilm(film, projectId);
  });
  const filmProjectIds = projects.filter((project) => project.projectKind === "film").map((project) => project.id);
  if (new Set(films.map((film) => film.projectId)).size !== films.length || filmProjectIds.some((id) => !films.some((film) => film.projectId === id))) {
    throw new Error("Workspace film payloads do not match film projects");
  }
  const assets = input.assets.map(parseAsset);
  const prompts = input.prompts.map(parsePrompt);
  const generationJobs = input.generationJobs.map((job, index) => {
    try {
      return validateGenerationJob(structuredClone(record(job, `Workspace generation job ${index}`)) as GenerationJob);
    } catch {
      throw new Error(`Invalid workspace generation job ${index}`);
    }
  });
  const rawWorkflowTemplates = input.version === 1 ? [] : input.workflowTemplates;
  if (!Array.isArray(rawWorkflowTemplates) || rawWorkflowTemplates.length > 1_000) {
    throw new Error("Invalid workspace workflow templates");
  }
  const workflowTemplates = rawWorkflowTemplates.map((template, index) => {
    try {
      const parsed = parseWorkflowTemplate(template);
      if (parsed.scope !== "personal") throw new Error("public template");
      return parsed;
    } catch {
      throw new Error(`Invalid workspace workflow template ${index}`);
    }
  });
  if (new Set(workflowTemplates.map((template) => template.id)).size !== workflowTemplates.length) {
    throw new Error("Duplicate workspace workflow template id");
  }
  if (generationJobs.some((job) => job.kind === "workflow" &&
    (job.status === "queued" || job.status === "running"))) {
    throw new Error("Cannot restore an active workflow run");
  }
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
    workflowTemplates,
    films,
    config: normalizeAppConfig(mergeBackupConfig(localConfig, config as BackupConfig)),
  };
}

function remap(snapshot: WorkspaceSnapshot, replacements: Map<string, StoredWorkspaceMedia>): WorkspaceSnapshot {
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
        if (node.type === "panorama") {
          node.metadata.naturalWidth = replacement.width;
          node.metadata.naturalHeight = replacement.height;
          node.metadata.bytes = replacement.bytes;
          node.metadata.mimeType = replacement.mimeType;
        }
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
    if (job.kind === "workflow") {
      const parameters = parseWorkflowRunParameters(job.parameters);
      const values = Object.fromEntries(Object.entries(parameters.values).map(([id, value]) => [
        id,
        Array.isArray(value) ? value.map((key) => replace(key)!.storageKey) : value,
      ])) as WorkflowValues;
      const result = parseWorkflowRunResult(job.result, parameters.templateSnapshot);
      const steps = Object.fromEntries(Object.entries(result.steps).map(([id, state]) => [
        id,
        state.storageKeys
          ? { ...state, storageKeys: state.storageKeys.map((key) => replace(key)!.storageKey) }
          : state,
      ]));
      job.parameters = { ...parameters, values };
      job.result = {
        steps,
        outputStorageKeys: result.outputStorageKeys.map((key) => replace(key)!.storageKey),
      } satisfies WorkflowRunResult;
      validateGenerationJob(job);
      continue;
    }
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
  copy.films = (copy.films ?? []).map((film) => ({
    ...film,
    shots: film.shots.map((shot) => ({
      ...shot,
      imageStorageKey: replace(shot.imageStorageKey)?.storageKey,
      firstFrameStorageKey: replace(shot.firstFrameStorageKey)?.storageKey,
      videoStorageKey: replace(shot.videoStorageKey)?.storageKey,
      audioStorageKey: replace(shot.audioStorageKey)?.storageKey,
    })),
    dialogues: film.dialogues?.map((dialogue) => ({
      ...dialogue,
      audioStorageKey: replace(dialogue.audioStorageKey)?.storageKey,
    })),
    assets: film.assets.map((asset) => ({
      ...asset,
      mediaStorageKey: replace(asset.mediaStorageKey)?.storageKey,
    })),
    tasks: film.tasks.map((task) => !task.snapshot ? task : ({
      ...task,
      snapshot: {
        ...task.snapshot,
        identityVersions: task.snapshot.identityVersions.map((asset) => ({
          ...asset,
          mediaStorageKey: replace(asset.mediaStorageKey)?.storageKey,
        })),
        styleVersion: task.snapshot.styleVersion ? {
          ...task.snapshot.styleVersion,
          mediaStorageKey: replace(task.snapshot.styleVersion.mediaStorageKey)?.storageKey,
        } : undefined,
        referenceStorageKeys: task.snapshot.referenceStorageKeys.map((key) => replace(key)!.storageKey),
      },
    })),
    timeline: {
      ...film.timeline,
      tracks: film.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, source: isFilmStorageKey(clip.source) ? replace(clip.source)!.storageKey : clip.source })),
      })),
    },
    deliverables: film.deliverables.map((deliverable) => ({
      ...deliverable,
      storageKey: replace(deliverable.storageKey)?.storageKey,
    })),
    versions: film.versions?.map((version) => version.entityType !== "shot" ? version : ({
      ...version,
      snapshot: Object.fromEntries(Object.entries(version.snapshot).map(([field, value]) =>
        filmShotMediaFields.includes(field as typeof filmShotMediaFields[number]) && typeof value === "string"
          ? [field, replace(value)?.storageKey] : [field, value])),
    })),
  }));
  return copy;
}

export async function importWorkspaceBundle(
  source: Blob | ArrayBuffer | Uint8Array,
  localConfig: AppConfig,
  storage: WorkspaceBundleStorage = defaultStorage,
  apply?: (snapshot: WorkspaceSnapshot, context: WorkspaceImportContext) => Promise<WorkspaceSnapshot | void>,
): Promise<WorkspaceSnapshot> {
  const entries = await readZipStore(source);
  const manifestBytes = entries.get("manifest.json");
  const workspaceBytes = entries.get("workspace.json");
  if (!manifestBytes || !workspaceBytes) throw new Error("Workspace manifest or document is missing");
  const manifest = parseManifest(decodeJSON(manifestBytes, "workspace manifest"));
  const snapshot = parseWorkspace(decodeJSON(workspaceBytes, "workspace document"), localConfig);
  snapshot.projects.forEach(assertBundlePanoramaMediaManaged);
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

  const replacements = new Map<string, StoredWorkspaceMedia>();
  const stored: Array<{ kind: MediaKind; storageKey: string }> = [];
  const importedMedia: ImportedWorkspaceMedia[] = [];
  const panoramaKeys = new Set(snapshot.projects.flatMap((project) => project.nodes
    .filter((node) => node.type === "panorama" && node.metadata.storageKey)
    .map((node) => node.metadata.storageKey!)));
  try {
    for (const item of manifest.media) {
      const bytes = entries.get(item.entry);
      if (!bytes || bytes.byteLength !== item.bytes) {
        throw new Error(`Workspace media size mismatch: ${item.entry}`);
      }
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: item.mimeType });
      let panoramaDimensions: { width: number; height: number } | undefined;
      if (panoramaKeys.has(item.storageKey)) {
        if (item.kind !== "image") throw new Error("Panorama workspace media must be an image");
        panoramaDimensions = await readPanoramaBlobDimensions(blob);
      }
      const replacement = await storage.store(
        item.kind,
        blob,
      );
      stored.push({ kind: item.kind, storageKey: replacement.storageKey });
      if (panoramaKeys.has(item.storageKey)) {
        await validatePanoramaBlob(new Blob([buffer], { type: replacement.mimeType }));
        validatePanoramaDimensions(replacement.width, replacement.height);
        if (replacement.bytes !== item.bytes || replacement.width !== panoramaDimensions?.width ||
            replacement.height !== panoramaDimensions.height) {
          throw new Error("Panorama workspace media changed during import");
        }
      }
      replacements.set(item.storageKey, replacement);
      const identity = await importedMediaIdentity(bytes, replacement.mimeType);
      importedMedia.push({ storageKey: replacement.storageKey, mimeType: replacement.mimeType, bytes: replacement.bytes, ...identity });
    }
    const restored = remap(snapshot, replacements);
    restored.projects.forEach((project) => validateProjectPanoramaBudget(project.nodes));
    const cleanupMigrated = async (storageKeys: readonly string[]) => {
      const selected = new Set(storageKeys);
      await Promise.all(stored.filter((item) => selected.has(item.storageKey)).map((item) => storage.remove(item.kind, item.storageKey)));
    };
    return await apply?.(restored, { media: importedMedia, cleanupMigrated }) ?? restored;
  } catch (error) {
    if (!(error instanceof WorkspaceReplacementRollbackError)) {
      await Promise.allSettled(stored.map((item) => storage.remove(item.kind, item.storageKey)));
    }
    throw error;
  }
}
