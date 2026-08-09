import type { BoardProject } from "@/types/board";
import type { FilmDocument } from "@/types/film";
import { parseBoardProject } from "@/lib/board-document";
import { createZipStore, readZipStore, type ZipStoreInput } from "@/lib/zip-store";
import { deleteBlob, getBlob, uploadMedia } from "@/services/storage";
import {
  readPanoramaBlobDimensions,
  validatePanoramaBlob,
  validatePanoramaDimensions,
  validateProjectPanoramaBudget,
} from "@/lib/panorama";
import { assertBundlePanoramaMediaManaged } from "@/lib/plain-project-import";

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
  version: 1 | 2;
  exportedAt: string;
  media: BundleMedia[];
  film?: { version: 2; entry: "film.json" } | null;
};

export type ImportedProjectBundle = {
  project: BoardProject;
  film?: FilmDocument;
  media: ImportedBundleMedia[];
  cleanup: () => Promise<void>;
  cleanupMigrated: (storageKeys: readonly string[]) => Promise<void>;
};

export type ImportedBundleMedia = {
  storageKey: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  objectVersion: string;
};

export type ProjectBundleStorage = {
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
type StoredBundleMedia = Awaited<ReturnType<ProjectBundleStorage["store"]>>;

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

const defaultStorage: ProjectBundleStorage = {
  load: getBlob,
  store: async (kind, blob) => {
    const result = await uploadMedia(blob, kind, { requirePersistent: true });
    return {
      storageKey: result.storageKey,
      url: result.url,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      mimeType: result.mimeType,
    };
  },
  remove: deleteBlob,
};

const decoder = new TextDecoder("utf-8", { fatal: true });

function kindForStorageKey(storageKey: string): MediaKind {
  return storageKey.startsWith("image:") ? "image" : "media";
}

function isFilmStorageKey(value: string): boolean {
  return value.startsWith("image:") || value.startsWith("media:") || value.startsWith("film:");
}

const filmShotMediaFields = ["imageStorageKey", "firstFrameStorageKey", "videoStorageKey", "audioStorageKey"] as const;

function collectFilmAssetKey(asset: FilmDocument["assets"][number] | undefined, keys: Set<string>): void {
  if (asset?.mediaStorageKey) keys.add(asset.mediaStorageKey);
}

function collectProjectKeys(project: BoardProject, film?: FilmDocument): string[] {
  const keys = new Set<string>();
  for (const node of project.nodes) {
    if (node.metadata.storageKey) keys.add(node.metadata.storageKey);
    for (const storageKey of node.metadata.referenceStorageKeys ?? []) keys.add(storageKey);
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

  for (const shot of film?.shots ?? []) {
    if (shot.imageStorageKey) keys.add(shot.imageStorageKey);
    if (shot.firstFrameStorageKey) keys.add(shot.firstFrameStorageKey);
    if (shot.videoStorageKey) keys.add(shot.videoStorageKey);
    if (shot.audioStorageKey) keys.add(shot.audioStorageKey);
  }
  for (const asset of film?.assets ?? []) {
    collectFilmAssetKey(asset, keys);
  }
  for (const dialogue of film?.dialogues ?? []) {
    if (dialogue.audioStorageKey) keys.add(dialogue.audioStorageKey);
  }
  for (const task of film?.tasks ?? []) {
    for (const asset of task.snapshot?.identityVersions ?? []) collectFilmAssetKey(asset, keys);
    collectFilmAssetKey(task.snapshot?.styleVersion, keys);
    for (const key of task.snapshot?.referenceStorageKeys ?? []) keys.add(key);
  }
  for (const track of film?.timeline.tracks ?? []) {
    for (const clip of track.clips) if (isFilmStorageKey(clip.source)) keys.add(clip.source);
  }
  for (const deliverable of film?.deliverables ?? []) {
    if (deliverable.storageKey) keys.add(deliverable.storageKey);
  }
  for (const version of film?.versions ?? []) {
    if (version.entityType !== "shot") continue;
    for (const field of filmShotMediaFields) {
      const key = version.snapshot[field];
      if (typeof key === "string") keys.add(key);
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
  film?: FilmDocument,
): Promise<Blob> {
  if (project.projectKind === "film" && !film) {
    throw new Error("Film project bundle requires its production payload");
  }
  if (film && film.projectId !== project.id) {
    throw new Error("Film production does not belong to this project");
  }
  const media: BundleMedia[] = [];
  const entries: ZipStoreInput[] = [];
  for (const [index, storageKey] of collectProjectKeys(project, film).entries()) {
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
    version: 2,
    exportedAt: new Date().toISOString(),
    media,
    film: film ? { version: 2, entry: "film.json" } : null,
  };
  return createZipStore([
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "project.json", data: JSON.stringify(canonicalProject(project, mediaByKey), null, 2) },
    ...(film ? [{ name: "film.json", data: JSON.stringify(film, null, 2) }] : []),
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
  const input = structuredClone(value as Record<string, unknown>);
  if (input.format !== "openboard.project-bundle" || (input.version !== 1 && input.version !== 2)) {
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
  let film: ProjectBundleManifest["film"];
  if (input.version === 2) {
    if (input.film !== null && (
      !input.film || typeof input.film !== "object" || Array.isArray(input.film) ||
      (input.film as Record<string, unknown>).version !== 2 ||
      (input.film as Record<string, unknown>).entry !== "film.json"
    )) {
      throw new Error("Invalid film bundle declaration");
    }
    film = input.film as ProjectBundleManifest["film"];
  }
  return {
    format: "openboard.project-bundle",
    version: input.version,
    exportedAt: input.exportedAt,
    media,
    film,
  };
}

export function parseBundleFilm(value: unknown, projectId: string): FilmDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid film bundle payload");
  }
  const input = structuredClone(value as Record<string, unknown>);
  const legacyStages = ["decompose", "script", "storyboard", "audio", "video", "compose", "delivery"];
  if (Array.isArray(input.stages) && input.stages.length === legacyStages.length && input.stages.every((stage, index) => (stage as Record<string, unknown>)?.id === legacyStages[index])) {
    const storyboard = input.stages[2] as Record<string, unknown>;
    input.stages.splice(3, 0, { id: "first_frame", revision: 1, status: storyboard.status === "approved" ? "approved" : "draft", updatedAt: input.updatedAt });
    if (storyboard.status === "approved" && Array.isArray(input.shots)) input.shots = input.shots.map((value) => {
      const shot = value as Record<string, unknown>;
      return { ...shot, firstFrameStorageKey: shot.firstFrameStorageKey ?? shot.imageStorageKey, firstFrameSha256: shot.firstFrameSha256 ?? shot.imageSha256, firstFrameObjectVersion: shot.firstFrameObjectVersion ?? shot.imageObjectVersion, firstFrameGenerationJobId: shot.firstFrameGenerationJobId ?? shot.imageGenerationJobId };
    });
  }
  for (const field of ["dialogues", "adoptions", "versions"] as const) {
    if (input[field] === undefined) input[field] = [];
  }
  const boundedCollections = [
    input.episodes, input.scenes, input.shots, input.assets, input.stages,
    input.dialogues, input.tasks, input.qualityReports, input.deliverables, input.adoptions, input.versions,
  ];
  if (
    input.schemaVersion !== 1 || input.projectId !== projectId ||
    typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
    !Array.isArray(input.episodes) || !Array.isArray(input.scenes) || !Array.isArray(input.shots) ||
    !Array.isArray(input.assets) || !Array.isArray(input.stages) || !Array.isArray(input.dialogues) || !Array.isArray(input.tasks) ||
    !Array.isArray(input.qualityReports) || !Array.isArray(input.deliverables) ||
    !Array.isArray(input.adoptions) || !Array.isArray(input.versions) ||
    !input.timeline || typeof input.timeline !== "object" ||
    boundedCollections.some((collection) => !Array.isArray(collection) || collection.length > 10_000)
  ) {
    throw new Error("Invalid film bundle payload");
  }
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  const statuses = new Set(["draft", "running", "needs_review", "approved", "failed", "canceled"]);
  const stageIds = ["decompose", "script", "storyboard", "first_frame", "audio", "video", "compose", "delivery"];
  const validEntity = (entity: unknown, idField = "id"): entity is Record<string, unknown> => {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) return false;
    const item = entity as Record<string, unknown>;
    return typeof item[idField] === "string" && idPattern.test(item[idField]) &&
      Number.isSafeInteger(item.revision) && Number(item.revision) >= 1;
  };
  const uniqueRecords = (values: unknown[], kind: string) => {
    const ids = new Set<string>();
    for (const value of values) {
      if (!validEntity(value)) throw new Error(`Invalid film ${kind}`);
      const id = value.id as string;
      if (ids.has(id)) throw new Error(`Duplicate film ${kind} id`);
      ids.add(id);
    }
    return ids;
  };
  const stages = input.stages as unknown[];
  if (stages.length !== stageIds.length || stages.some((stage, index) => {
    if (!validEntity(stage)) return true;
    return stage.id !== stageIds[index] || typeof stage.status !== "string" || !statuses.has(stage.status) ||
      typeof stage.updatedAt !== "string" || !Number.isFinite(Date.parse(stage.updatedAt));
  })) {
    throw new Error("Invalid film stage topology");
  }
  uniqueRecords(stages, "stage");

  const episodes = input.episodes as unknown[];
  const scenes = input.scenes as unknown[];
  const shots = input.shots as unknown[];
  const assets = input.assets as unknown[];
  if (episodes.length + scenes.length + shots.length + assets.length > 10_000) {
    throw new Error("Film bundle contains too many entities");
  }
  const episodeIds = uniqueRecords(episodes, "episode");
  const sceneIds = uniqueRecords(scenes, "scene");
  uniqueRecords(shots, "shot");
  const assetIds = uniqueRecords(assets, "asset");
  const validStatus = (record: Record<string, unknown>) =>
    typeof record.status === "string" && statuses.has(record.status);
  for (const value of episodes) {
    const episode = value as Record<string, unknown>;
    if (!validStatus(episode) || typeof episode.title !== "string" || !episode.title.trim() || episode.title.length > 500 ||
      typeof episode.synopsis !== "string" || episode.synopsis.length > 20_000 || !Number.isSafeInteger(episode.order) || Number(episode.order) < 0) {
      throw new Error("Invalid film episode");
    }
  }
  for (const value of scenes) {
    const scene = value as Record<string, unknown>;
    if (!validStatus(scene) || typeof scene.episodeId !== "string" || !episodeIds.has(scene.episodeId) ||
      typeof scene.heading !== "string" || !scene.heading.trim() || scene.heading.length > 500 ||
      typeof scene.synopsis !== "string" || scene.synopsis.length > 20_000 || !Number.isSafeInteger(scene.order) || Number(scene.order) < 0) {
      throw new Error("Invalid film scene relation");
    }
  }
  const assetKinds = new Set(["character", "identity", "location", "prop", "style", "voice"]);
  const assetsById = new Map<string, Record<string, unknown>>();
  for (const value of assets) {
    const asset = value as Record<string, unknown>;
    assetsById.set(asset.id as string, asset);
    if (!validStatus(asset) || typeof asset.kind !== "string" || !assetKinds.has(asset.kind) || typeof asset.title !== "string" || !asset.title.trim() ||
      typeof asset.description !== "string" || (asset.parentAssetId !== undefined &&
        (typeof asset.parentAssetId !== "string" || !assetIds.has(asset.parentAssetId) || asset.parentAssetId === asset.id))) {
      throw new Error("Invalid film asset");
    }
  }
  for (const value of shots) {
    const shot = value as Record<string, unknown>;
    if (!validStatus(shot) || typeof shot.sceneId !== "string" || !sceneIds.has(shot.sceneId) ||
      typeof shot.title !== "string" || !shot.title.trim() || typeof shot.description !== "string" || !shot.description.trim() ||
      typeof shot.durationSeconds !== "number" || !Number.isFinite(shot.durationSeconds) || shot.durationSeconds <= 0 || shot.durationSeconds > 900 ||
      !Array.isArray(shot.identityVersionIds) || shot.identityVersionIds.length > 100 ||
      shot.identityVersionIds.some((id) => typeof id !== "string" || assetsById.get(id)?.kind !== "identity") ||
      (shot.styleAssetId !== undefined && (typeof shot.styleAssetId !== "string" || assetsById.get(shot.styleAssetId)?.kind !== "style"))) {
      throw new Error("Invalid film shot relation");
    }
  }

  const dialogues = input.dialogues as unknown[];
  uniqueRecords(dialogues, "dialogue");
  const shotIds = new Set(shots.map((shot) => (shot as Record<string, unknown>).id as string));
  for (const value of dialogues) {
    const dialogue = value as Record<string, unknown>;
    if (!shotIds.has(String(dialogue.shotId)) || !["dialogue", "narration"].includes(String(dialogue.kind)) ||
      typeof dialogue.text !== "string" || !dialogue.text.trim() || dialogue.text.length > 20_000) {
      throw new Error("Invalid film dialogue");
    }
  }

  const versions = input.versions as unknown[];
  uniqueRecords(versions, "entity version");
  for (const value of versions) {
    const version = value as Record<string, unknown>;
    if (!["shot", "asset", "timeline"].includes(String(version.entityType)) ||
      !version.snapshot || typeof version.snapshot !== "object" || Array.isArray(version.snapshot) ||
      JSON.stringify(version.snapshot).length > 256_000) {
      throw new Error("Invalid film entity version");
    }
  }

  const adoptions = input.adoptions as unknown[];
  uniqueRecords(adoptions, "media adoption");

  const tasks = input.tasks as unknown[];
  if (tasks.length > 1_000) throw new Error("Film bundle contains too many tasks");
  uniqueRecords(tasks, "task");
  for (const value of tasks) {
    const task = value as Record<string, unknown>;
    if (!stageIds.includes(String(task.stage)) || !validStatus(task) || typeof task.progress !== "number" ||
      !Number.isFinite(task.progress) || task.progress < 0 || task.progress > 1) {
      throw new Error("Invalid film task");
    }
  }

  const reports = input.qualityReports as unknown[];
  if (reports.length > 20) throw new Error("Film bundle contains too many quality reports");
  uniqueRecords(reports, "quality report");
  let issueCount = 0;
  let repairCount = 0;
  for (const value of reports) {
    const report = value as Record<string, unknown>;
    if (!Array.isArray(report.issues) || !Array.isArray(report.repairs)) throw new Error("Invalid film quality report");
    issueCount += report.issues.length;
    repairCount += report.repairs.length;
    if (issueCount > 10_000 || repairCount > 5_000) throw new Error("Film bundle quality data exceeds limits");
    uniqueRecords(report.issues.map((issue) => ({ ...(issue as object), revision: 1 })), "quality issue");
    uniqueRecords(report.repairs.map((repair) => ({ ...(repair as object), revision: 1 })), "repair proposal");
  }

  const timeline = input.timeline as Record<string, unknown>;
  if (!Number.isSafeInteger(timeline.revision) || Number(timeline.revision) < 1 ||
    !Array.isArray(timeline.tracks) || timeline.tracks.length !== 5) {
    throw new Error("Invalid film timeline");
  }
  uniqueRecords(timeline.tracks, "timeline track");
  const trackKinds = new Set<string>();
  let clipCount = 0;
  for (const value of timeline.tracks) {
    const track = value as Record<string, unknown>;
    if (!["video", "dialogue", "music", "sfx", "subtitle"].includes(String(track.kind)) || trackKinds.has(String(track.kind)) || !Array.isArray(track.clips)) {
      throw new Error("Invalid film timeline track");
    }
    trackKinds.add(String(track.kind));
    clipCount += track.clips.length;
    if (clipCount > 10_000) throw new Error("Film bundle timeline exceeds limits");
    uniqueRecords(track.clips, "timeline clip");
  }

  const deliverables = input.deliverables as unknown[];
  if (deliverables.length > 100) throw new Error("Film bundle contains too many deliverables");
  uniqueRecords(deliverables, "deliverable");
  for (const value of deliverables) {
    const deliverable = value as Record<string, unknown>;
    const kinds = new Set(["mp4", "srt", "manifest", "asset_bundle"]);
    const external = typeof deliverable.storageKey === "string" && isFilmStorageKey(deliverable.storageKey);
    const inline = typeof deliverable.content === "string";
    const validBytes = deliverable.bytes === undefined || Number.isSafeInteger(deliverable.bytes) && Number(deliverable.bytes) >= 0;
    const inlineBytesMatch = !inline || Number.isSafeInteger(deliverable.bytes) && deliverable.bytes === new TextEncoder().encode(deliverable.content as string).byteLength;
    if (!kinds.has(String(deliverable.kind)) || !validStatus(deliverable) || typeof deliverable.title !== "string" ||
      typeof deliverable.mimeType !== "string" || typeof deliverable.createdAt !== "string" || !Number.isFinite(Date.parse(deliverable.createdAt)) ||
      !validBytes || !inlineBytesMatch || (inline && deliverable.kind !== "manifest" && deliverable.kind !== "srt") ||
      (deliverable.storageKey !== undefined && !external)) {
      throw new Error("Invalid film deliverable");
    }
  }

  if (!input.source || typeof input.source !== "object" || Array.isArray(input.source) ||
    typeof (input.source as Record<string, unknown>).text !== "string" ||
    ((input.source as Record<string, unknown>).text as string).length > 1024 * 1024 ||
    !Number.isSafeInteger(input.projectionRevision) || Number(input.projectionRevision) < 0 ||
    typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt)) ||
    typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) {
    throw new Error("Invalid film bundle metadata");
  }
  return input as unknown as FilmDocument;
}

function remapProject(
  project: BoardProject,
  replacements: Map<string, StoredBundleMedia>,
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
      if (node.type === "panorama") {
        node.metadata.naturalWidth = result.width;
        node.metadata.naturalHeight = result.height;
        node.metadata.bytes = result.bytes;
        node.metadata.mimeType = result.mimeType;
      }
    }
    node.metadata.referenceStorageKeys = node.metadata.referenceStorageKeys?.map((storageKey) =>
      replace(storageKey)!.storageKey);
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

function remapFilm(
  film: FilmDocument,
  replacements: Map<string, StoredBundleMedia>,
): FilmDocument {
  const replace = (storageKey: string | undefined) => {
    if (!storageKey) return undefined;
    const result = replacements.get(storageKey);
    if (!result) throw new Error(`Bundle media declaration is missing: ${storageKey}`);
    return result.storageKey;
  };
  const remapAsset = (asset: FilmDocument["assets"][number]) => ({
    ...asset,
    mediaStorageKey: replace(asset.mediaStorageKey),
  });
  return {
    ...film,
    shots: film.shots.map((shot) => ({
      ...shot,
      imageStorageKey: replace(shot.imageStorageKey),
      firstFrameStorageKey: replace(shot.firstFrameStorageKey),
      videoStorageKey: replace(shot.videoStorageKey),
      audioStorageKey: replace(shot.audioStorageKey),
    })),
    dialogues: film.dialogues?.map((dialogue) => ({
      ...dialogue,
      audioStorageKey: replace(dialogue.audioStorageKey),
    })),
    assets: film.assets.map(remapAsset),
    tasks: film.tasks.map((task) => !task.snapshot ? task : ({
      ...task,
      snapshot: {
        ...task.snapshot,
        identityVersions: task.snapshot.identityVersions.map(remapAsset),
        styleVersion: task.snapshot.styleVersion ? remapAsset(task.snapshot.styleVersion) : undefined,
        referenceStorageKeys: task.snapshot.referenceStorageKeys.map((key) => replace(key)!),
      },
    })),
    timeline: {
      ...film.timeline,
      tracks: film.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, source: isFilmStorageKey(clip.source) ? replace(clip.source)! : clip.source })),
      })),
    },
    deliverables: film.deliverables.map((deliverable) => ({
      ...deliverable,
      storageKey: replace(deliverable.storageKey),
    })),
    versions: film.versions?.map((version) => version.entityType !== "shot" ? version : ({
      ...version,
      snapshot: Object.fromEntries(Object.entries(version.snapshot).map(([field, value]) =>
        filmShotMediaFields.includes(field as typeof filmShotMediaFields[number]) && typeof value === "string"
          ? [field, replace(value)] : [field, value])),
    })),
  };
}

export async function importProjectBundle(
  source: Blob | ArrayBuffer | Uint8Array,
  storage: ProjectBundleStorage = defaultStorage,
): Promise<BoardProject> {
  return (await importProjectBundlePayload(source, storage)).project;
}

export async function importProjectBundlePayload(
  source: Blob | ArrayBuffer | Uint8Array,
  storage: ProjectBundleStorage = defaultStorage,
): Promise<ImportedProjectBundle> {
  const entries = await readZipStore(source);
  const manifestBytes = entries.get("manifest.json");
  const projectBytes = entries.get("project.json");
  if (!manifestBytes || !projectBytes) throw new Error("Bundle manifest or project is missing");
  const manifest = parseManifest(decodeJSON(manifestBytes, "bundle manifest"));
  const project = assertBundlePanoramaMediaManaged(
    parseBoardProject(decodeJSON(projectBytes, "project document")),
  );
  const filmBytes = manifest.film ? entries.get(manifest.film.entry) : undefined;
  if (manifest.film && !filmBytes) throw new Error("Bundle film payload is missing");
  if (filmBytes && filmBytes.byteLength > 32 * 1024 * 1024) throw new Error("Bundle film payload is too large");
  const film = filmBytes ? parseBundleFilm(decodeJSON(filmBytes, "film document"), project.id) : undefined;
  if (project.projectKind === "film" && !film) throw new Error("Film project bundle is missing its production payload");
  if (project.projectKind === "canvas" && film) throw new Error("Canvas project bundle cannot contain a film payload");

  const declaredEntries = new Set([
    "manifest.json",
    "project.json",
    ...(manifest.film ? [manifest.film.entry] : []),
    ...manifest.media.map((item) => item.entry),
  ]);
  for (const name of entries.keys()) {
    if (!declaredEntries.has(name)) throw new Error(`Bundle contains undeclared entry: ${name}`);
  }
  if (entries.size !== declaredEntries.size) throw new Error("Bundle is missing a declared entry");

  const projectKeys = new Set(collectProjectKeys(project, film));
  const manifestKeys = new Set(manifest.media.map((item) => item.storageKey));
  if (
    projectKeys.size !== manifestKeys.size ||
    [...projectKeys].some((key) => !manifestKeys.has(key))
  ) {
    throw new Error("Bundle project media references do not match the manifest");
  }

  const replacements = new Map<string, StoredBundleMedia>();
  const stored: Array<{ kind: MediaKind; storageKey: string }> = [];
  const importedMedia: ImportedBundleMedia[] = [];
  const panoramaKeys = new Set(project.nodes
    .filter((node) => node.type === "panorama" && node.metadata.storageKey)
    .map((node) => node.metadata.storageKey!));
  try {
    for (const item of manifest.media) {
      const data = entries.get(item.entry);
      if (!data || data.byteLength !== item.bytes) {
        throw new Error(`Bundle media size mismatch: ${item.entry}`);
      }
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      const blob = new Blob([buffer], { type: item.mimeType });
      let panoramaDimensions: { width: number; height: number } | undefined;
      if (panoramaKeys.has(item.storageKey)) {
        if (item.kind !== "image") throw new Error("Panorama bundle media must be an image");
        panoramaDimensions = await readPanoramaBlobDimensions(blob);
      }
      const result = await storage.store(
        item.kind,
        blob,
      );
      stored.push({ kind: item.kind, storageKey: result.storageKey });
      if (panoramaKeys.has(item.storageKey)) {
        await validatePanoramaBlob(new Blob([buffer], { type: result.mimeType }));
        validatePanoramaDimensions(result.width, result.height);
        if (result.bytes !== item.bytes || result.width !== panoramaDimensions?.width ||
            result.height !== panoramaDimensions.height) {
          throw new Error("Panorama bundle media changed during import");
        }
      }
      replacements.set(item.storageKey, result);
      const identity = await importedMediaIdentity(data, result.mimeType);
      importedMedia.push({ storageKey: result.storageKey, mimeType: result.mimeType, bytes: result.bytes, ...identity });
    }
    const restored = remapProject(project, replacements);
    validateProjectPanoramaBudget(restored.nodes);
    return {
      project: restored,
      ...(film ? { film: remapFilm(film, replacements) } : {}),
      media: importedMedia,
      cleanup: async () => {
        await Promise.all(stored.map((item) => storage.remove(item.kind, item.storageKey)));
      },
      cleanupMigrated: async (storageKeys) => {
        const selected = new Set(storageKeys);
        await Promise.all(stored.filter((item) => selected.has(item.storageKey)).map((item) => storage.remove(item.kind, item.storageKey)));
      },
    };
  } catch (error) {
    await Promise.allSettled(
      stored.map((item) => storage.remove(item.kind, item.storageKey)),
    );
    throw error;
  }
}
