import { clear, createStore, del, entries, get, set } from "idb-keyval";
import type { AppConfig, AssetItem, AssistantSession, BoardNode, BoardProject, PromptItem } from "@/types/board";
import { decodeBoundedDataUrl, readBoundedResponse } from "@/services/remote-content";
import { normalizeExternalHttpsUrl } from "@/lib/remote-url";
import { normalizeChannel } from "@/lib/ai-config";
import { normalizeObjectStorage, stripObjectStorageSecrets } from "@/lib/object-storage";
import { parseBoardProject } from "@/lib/board-document";
import { readPanoramaBlobDimensions, validateProjectPanoramaBudget } from "@/lib/panorama";
import {
  deleteServerBlob,
  deleteServerProject,
  getServerBlob,
  loadServerProjects,
  loadServerSecrets,
  loadServerState,
  putServerBlob,
  replaceServerProjects,
  saveServerProjects,
  saveServerSecrets,
  saveServerState,
} from "@/services/server-storage";

const SERVER_STORAGE = import.meta.env.VITE_OPENBOARD_STORAGE === "server";

// idb-keyval createStore only ensures the *requested* object store exists.
// Using one DB name with three stores leaves later stores missing after first open.
// Separate DBs avoid upgrade races and the "object store was not found" crash.
const appStore = createStore("openboard-app", "app_state");
const imageStore = createStore("openboard-images", "files");
const mediaStore = createStore("openboard-media", "files");

const PROJECTS_KEY = "openboard:projects";
const CONFIG_KEY = "openboard:config";
const ASSETS_KEY = "openboard:assets";
const PROMPTS_KEY = "openboard:prompts";
const CONFIG_SECRETS_KEY = "openboard:config-secrets";

let serverMigration: Promise<void> | undefined;

type StoredBlobRecord = {
  version: 1;
  mimeType: string;
  bytes: ArrayBuffer;
};

function storedValueToBlob(value: unknown): Blob | undefined {
  if (value instanceof Blob) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<StoredBlobRecord>;
  if (record.version !== 1 || typeof record.mimeType !== "string" || !(record.bytes instanceof ArrayBuffer)) {
    return undefined;
  }
  return new Blob([record.bytes], { type: record.mimeType });
}

function ensureServerMigration(): Promise<void> {
  if (!SERVER_STORAGE) return Promise.resolve();
  if (serverMigration) return serverMigration;
  serverMigration = (async () => {
    const [remoteProjects, remoteConfig, remoteAssets, remotePrompts] = await Promise.all([
      loadServerProjects(),
      loadServerState<AppConfig>("config"),
      loadServerState<AssetItem[]>("assets"),
      loadServerState<PromptItem[]>("prompts"),
    ]);
    const remoteHasData = remoteProjects.length > 0 || remoteConfig !== null ||
      remoteAssets !== null || remotePrompts !== null;
    if (remoteHasData) return;

    const [projects, config, assets, prompts, images, media] = await Promise.all([
      get<BoardProject[]>(PROJECTS_KEY, appStore),
      get<AppConfig>(CONFIG_KEY, appStore),
      get<AssetItem[]>(ASSETS_KEY, appStore),
      get<PromptItem[]>(PROMPTS_KEY, appStore),
      entries(imageStore),
      entries(mediaStore),
    ]);
    const hasLegacyData = Boolean(projects?.length || config || assets?.length || prompts?.length || images.length || media.length);
    if (!hasLegacyData) return;

    await Promise.all([
      saveServerProjects(projects ?? []),
      ...(config ? [
        saveServerState("config", sanitizeConfigForPersistence(config)),
        saveServerSecrets(extractConfigSecrets(config)),
      ] : []),
      saveServerState("assets", assets ?? []),
      saveServerState("prompts", prompts ?? []),
      ...[...images, ...media].map(([key, value]) => {
        const blob = storedValueToBlob(value);
        return typeof key === "string" && blob ? putServerBlob(key, blob) : Promise.resolve();
      }),
    ]);
    await Promise.all([clear(appStore), clear(imageStore), clear(mediaStore)]);
  })();
  return serverMigration;
}

const objectUrls = new Map<string, string>();

export const MEDIA_UPLOAD_LIMITS = {
  imageBytes: 32 * 1024 * 1024,
  mediaBytes: 256 * 1024 * 1024,
} as const;

const REMOTE_IMAGE_MIME_TYPES = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const REMOTE_MEDIA_MIME_TYPES = [
  ...REMOTE_IMAGE_MIME_TYPES,
  "audio/",
  "video/",
] as const;

export async function loadProjects(): Promise<BoardProject[]> {
  if (SERVER_STORAGE) {
    await ensureServerMigration();
    return loadServerProjects();
  }
  const projects = (await get<unknown[]>(PROJECTS_KEY, appStore)) ?? [];
  return projects.map(parseBoardProject);
}

export async function saveProjects(projects: BoardProject[]): Promise<void> {
  if (SERVER_STORAGE) return saveServerProjects(projects);
  await set(PROJECTS_KEY, projects, appStore);
}

/** Explicit deletes for user-driven project removal. Ordinary save never deletes remote projects. */
export async function deleteProjectsById(ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  if (SERVER_STORAGE) {
    await Promise.all(unique.map((id) => deleteServerProject(id)));
    return;
  }
  const current = ((await get<BoardProject[]>(PROJECTS_KEY, appStore)) ?? [])
    .filter((project) => !unique.includes(project.id));
  await set(PROJECTS_KEY, current, appStore);
}

/** Full project-catalog replacement for workspace restore only. */
export async function replaceProjects(projects: BoardProject[]): Promise<void> {
  if (SERVER_STORAGE) return replaceServerProjects(projects);
  await set(PROJECTS_KEY, projects, appStore);
}

export type ConfigSecrets = {
  apiKeys: Record<string, Record<string, string>>;
  webdavPass: string;
  objectStorageAccessKeyId?: string;
  objectStorageSecretAccessKey?: string;
  objectStorageSessionToken?: string;
};

export function mergeConfigSecrets(
	session: ConfigSecrets,
	persisted: ConfigSecrets,
): ConfigSecrets {
	const apiKeys: Record<string, Record<string, string>> = Object.fromEntries(
		Object.entries(session.apiKeys).map(([id, keys]) => [id, { ...keys }]),
	);
	for (const [id, keys] of Object.entries(persisted.apiKeys)) {
		const nonEmpty = Object.fromEntries(Object.entries(keys).filter(([, key]) => key !== ""));
		if (Object.keys(nonEmpty).length > 0) {
			apiKeys[id] = { ...(apiKeys[id] ?? {}), ...nonEmpty };
		}
	}
	return {
		apiKeys,
		webdavPass: persisted.webdavPass || session.webdavPass,
		objectStorageAccessKeyId: persisted.objectStorageAccessKeyId || session.objectStorageAccessKeyId || "",
		objectStorageSecretAccessKey: persisted.objectStorageSecretAccessKey || session.objectStorageSecretAccessKey || "",
		objectStorageSessionToken: persisted.objectStorageSessionToken || session.objectStorageSessionToken || "",
	};
}

export function sanitizeConfigForPersistence(config: AppConfig): AppConfig {
  const objectStorage = config.objectStorage
    ? stripObjectStorageSecrets(normalizeObjectStorage(config.objectStorage))
    : undefined;
  return {
    ...config,
    channels: config.channels.map((channel) => {
      const n = normalizeChannel(channel);
      const p = n.providers!;
      return { ...n, apiKey: "", providers: { text: { ...p.text, apiKey: "" }, image: { ...p.image, apiKey: "" }, video: { ...p.video, apiKey: "" }, audio: { ...p.audio, apiKey: "" } } };
    }),
    webdavPass: "",
    objectStorage,
  };
}

function extractConfigSecrets(config: AppConfig): ConfigSecrets {
  const objectStorage = config.objectStorage ? normalizeObjectStorage(config.objectStorage) : undefined;
  return {
    apiKeys: Object.fromEntries(config.channels.map((channel) => {
      const p = normalizeChannel(channel).providers!;
      return [channel.id, { text: p.text.apiKey, image: p.image.apiKey, video: p.video.apiKey, audio: p.audio.apiKey }];
    })),
    webdavPass: config.webdavPass ?? "",
    objectStorageAccessKeyId: objectStorage?.accessKeyId ?? "",
    objectStorageSecretAccessKey: objectStorage?.secretAccessKey ?? "",
    objectStorageSessionToken: objectStorage?.sessionToken ?? "",
  };
}

function readSessionConfigSecrets(): ConfigSecrets {
  const empty: ConfigSecrets = { apiKeys: {}, webdavPass: "", objectStorageAccessKeyId: "", objectStorageSecretAccessKey: "", objectStorageSessionToken: "" };
  if (typeof sessionStorage === "undefined") return empty;
  try {
    const value = JSON.parse(sessionStorage.getItem(CONFIG_SECRETS_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const input = value as { apiKeys?: unknown; webdavPass?: unknown; objectStorageAccessKeyId?: unknown; objectStorageSecretAccessKey?: unknown; objectStorageSessionToken?: unknown };
    const apiKeys: Record<string, Record<string, string>> = {};
    if (input.apiKeys && typeof input.apiKeys === "object" && !Array.isArray(input.apiKeys)) {
      for (const [id, value] of Object.entries(input.apiKeys)) {
        if (id.length > 128 || !value || (typeof value !== "object" && typeof value !== "string" ) || Array.isArray(value)) continue;
        const channelKeys: Record<string, string> = {};
        if (typeof value === "string") { channelKeys.text = value; apiKeys[id] = channelKeys; continue; }
        for (const [kind, key] of Object.entries(value)) {
          if (typeof key === "string" && key.length <= 64 * 1024) channelKeys[kind] = key;
        }
        apiKeys[id] = channelKeys;
      }
    }
    return {
      apiKeys,
      webdavPass: typeof input.webdavPass === "string" && input.webdavPass.length <= 64 * 1024
        ? input.webdavPass
        : "",
      objectStorageAccessKeyId: typeof input.objectStorageAccessKeyId === "string" && input.objectStorageAccessKeyId.length <= 64 * 1024
        ? input.objectStorageAccessKeyId
        : "",
      objectStorageSecretAccessKey: typeof input.objectStorageSecretAccessKey === "string" && input.objectStorageSecretAccessKey.length <= 64 * 1024
        ? input.objectStorageSecretAccessKey
        : "",
      objectStorageSessionToken: typeof input.objectStorageSessionToken === "string" && input.objectStorageSessionToken.length <= 64 * 1024
        ? input.objectStorageSessionToken
        : "",
    };
  } catch {
    return empty;
  }
}

function writeSessionConfigSecrets(secrets: ConfigSecrets): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(CONFIG_SECRETS_KEY, JSON.stringify(secrets));
  } catch {
    // The live config remains usable when private browsing denies session storage.
  }
}

export async function loadConfig(): Promise<AppConfig | null> {
  await ensureServerMigration();
  const stored = SERVER_STORAGE
    ? await loadServerState<AppConfig>("config")
    : (await get<AppConfig>(CONFIG_KEY, appStore)) ?? null;
  if (!stored) return null;
  const sessionSecrets = SERVER_STORAGE
    ? (await loadServerSecrets<ConfigSecrets>()) ?? { apiKeys: {}, webdavPass: "", objectStorageAccessKeyId: "", objectStorageSecretAccessKey: "", objectStorageSessionToken: "" }
    : readSessionConfigSecrets();
  const persistedSecrets = extractConfigSecrets(stored);
	const secrets = mergeConfigSecrets(sessionSecrets, persistedSecrets);
  if (!SERVER_STORAGE) writeSessionConfigSecrets(secrets);

  const sanitized = sanitizeConfigForPersistence(stored);
  if (Object.values(persistedSecrets.apiKeys).some(Boolean) || persistedSecrets.webdavPass || persistedSecrets.objectStorageAccessKeyId || persistedSecrets.objectStorageSecretAccessKey || persistedSecrets.objectStorageSessionToken) {
    if (SERVER_STORAGE) await saveServerState("config", sanitized);
    else await set(CONFIG_KEY, sanitized, appStore);
  }
  const objectStorage = normalizeObjectStorage(sanitized.objectStorage);
  return {
    ...sanitized,
    channels: sanitized.channels.map((raw) => {
      const channel = normalizeChannel(raw);
      const keys = secrets.apiKeys[channel.id] ?? {};
      const providers = Object.fromEntries(Object.entries(channel.providers!).map(([kind, provider]) => [kind, { ...provider, apiKey: keys[kind] ?? "" }])) as NonNullable<typeof channel.providers>;
      return { ...channel, providers, apiKey: providers.text.apiKey };
    }),
    webdavPass: secrets.webdavPass,
    objectStorage: {
      ...objectStorage,
      accessKeyId: secrets.objectStorageAccessKeyId || "",
      secretAccessKey: secrets.objectStorageSecretAccessKey || "",
      sessionToken: secrets.objectStorageSessionToken || "",
    },
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const secrets = extractConfigSecrets(config);
  if (SERVER_STORAGE) await saveServerSecrets(secrets);
  else writeSessionConfigSecrets(secrets);
  const sanitized = sanitizeConfigForPersistence(config);
  if (SERVER_STORAGE) await saveServerState("config", sanitized);
  else await set(CONFIG_KEY, sanitized, appStore);
}

export async function loadAssets(): Promise<AssetItem[]> {
  if (SERVER_STORAGE) {
    await ensureServerMigration();
    return (await loadServerState<AssetItem[]>("assets")) ?? [];
  }
  return (await get<AssetItem[]>(ASSETS_KEY, appStore)) ?? [];
}

export async function saveAssets(assets: AssetItem[]): Promise<void> {
  if (SERVER_STORAGE) return saveServerState("assets", assets);
  await set(ASSETS_KEY, assets, appStore);
}

export async function loadPrompts(): Promise<PromptItem[]> {
  if (SERVER_STORAGE) {
    await ensureServerMigration();
    return (await loadServerState<PromptItem[]>("prompts")) ?? [];
  }
  return (await get<PromptItem[]>(PROMPTS_KEY, appStore)) ?? [];
}

export async function savePrompts(prompts: PromptItem[]): Promise<void> {
  if (SERVER_STORAGE) return saveServerState("prompts", prompts);
  await set(PROMPTS_KEY, prompts, appStore);
}

export async function putBlob(
  kind: "image" | "media",
  key: string,
  blob: Blob,
): Promise<void> {
  if (SERVER_STORAGE) return putServerBlob(key, blob);
  const record: StoredBlobRecord = {
    version: 1,
    mimeType: blob.type || "application/octet-stream",
    bytes: await blob.arrayBuffer(),
  };
  await set(key, record, kind === "image" ? imageStore : mediaStore);
}

export async function getBlob(
  kind: "image" | "media",
  key: string,
): Promise<Blob | undefined> {
  if (SERVER_STORAGE) return getServerBlob(key);
  return storedValueToBlob(await get<unknown>(key, kind === "image" ? imageStore : mediaStore));
}

export async function deleteBlob(kind: "image" | "media", key: string): Promise<void> {
  if (SERVER_STORAGE) {
    await deleteServerBlob(key);
    const serverURL = objectUrls.get(key);
    if (serverURL) URL.revokeObjectURL(serverURL);
    objectUrls.delete(key);
    return;
  }
  await del(key, kind === "image" ? imageStore : mediaStore);
  const url = objectUrls.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(key);
  }
}

export async function storeImportedMedia(
  kind: "image" | "media",
  blob: Blob,
): Promise<{
  storageKey: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}> {
  const maxBytes = kind === "image"
    ? MEDIA_UPLOAD_LIMITS.imageBytes
    : MEDIA_UPLOAD_LIMITS.mediaBytes;
  if (blob.size > maxBytes) throw new Error(`Media is too large (limit ${maxBytes} bytes)`);
  const storageKey = `${kind}:${createStorageId()}`;
  await putBlob(kind, storageKey, blob);
  try {
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const dimensions = kind === "image" ? await readImageSize(url) : { width: 0, height: 0 };
    return {
      storageKey,
      url,
      width: dimensions.width,
      height: dimensions.height,
      bytes: blob.size,
      mimeType: blob.type || "application/octet-stream",
    };
  } catch (error) {
    await deleteBlob(kind, storageKey);
    throw error;
  }
}

export async function resolveObjectUrl(
  kind: "image" | "media",
  storageKey: string,
  fallback?: string,
): Promise<string | undefined> {
  const cached = objectUrls.get(storageKey);
  if (cached) return cached;
  const blob = await getBlob(kind, storageKey);
  if (!blob) return fallback;
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  return url;
}

function mediaKindFromKey(storageKey: string): "image" | "media" {
  return storageKey.startsWith("media:") ? "media" : "image";
}

export async function uploadMedia(
  input: Blob | string,
  kind: "image" | "media" = "image",
  options: {
    requirePersistent?: boolean;
    preflightImage?: (blob: Blob) => Promise<{ width: number; height: number }>;
  } = {},
): Promise<{
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  blob: Blob;
}> {
  let blob: Blob;
  const maxBytes = kind === "image"
    ? MEDIA_UPLOAD_LIMITS.imageBytes
    : MEDIA_UPLOAD_LIMITS.mediaBytes;
  if (typeof input === "string") {
    if (input.startsWith("data:")) {
      const decoded = decodeBoundedDataUrl(input, {
        maxBytes,
        mimeTypes: kind === "image" ? REMOTE_IMAGE_MIME_TYPES : REMOTE_MEDIA_MIME_TYPES,
      });
      blob = new Blob([decoded.bytes], { type: decoded.mimeType });
    } else if (input.startsWith("blob:")) {
      const response = await fetch(input);
      const remote = await readBoundedResponse(response, {
        maxBytes,
        mimeTypes: kind === "image" ? REMOTE_IMAGE_MIME_TYPES : REMOTE_MEDIA_MIME_TYPES,
      });
      blob = new Blob([remote.bytes], { type: remote.mimeType });
    } else if (/^https?:\/\//i.test(input)) {
      const res = await fetch(normalizeExternalHttpsUrl(input), {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!res.ok) throw new Error(`Failed to fetch media: ${res.status}`);
      const remote = await readBoundedResponse(res, {
        maxBytes,
        mimeTypes: kind === "image" ? REMOTE_IMAGE_MIME_TYPES : REMOTE_MEDIA_MIME_TYPES,
      });
      blob = new Blob([remote.bytes], { type: remote.mimeType });
    } else {
      throw new Error("Unsupported media input");
    }
  } else {
    blob = input;
    if (blob.size > maxBytes) {
      throw new Error(`Media is too large (limit ${maxBytes} bytes)`);
    }
  }

  const preflightDimensions = options.preflightImage && (blob.type.startsWith("image/") || kind === "image")
    ? await options.preflightImage(blob)
    : undefined;

  const storageKey = `${kind}:${createStorageId()}`;
  let url: string | undefined;
  try {
    await putBlob(kind, storageKey, blob);
  } catch (cause) {
    if (options.requirePersistent) throw cause;
    url = await blobToDataUrl(blob);
  }
  if (!url) {
    try {
      url = URL.createObjectURL(blob);
      objectUrls.set(storageKey, url);
    } catch (cause) {
      if (options.requirePersistent) {
        try {
          await deleteBlob(kind, storageKey);
        } catch (cleanupError) {
          throw new AggregateError([cause, cleanupError], "Media URL creation failed and stored blob cleanup failed");
        }
        throw cause;
      }
      // Some private/WebKit contexts reject object URLs. The stored key remains valid.
      url = await blobToDataUrl(blob);
    }
  }

  let width = preflightDimensions?.width ?? 0;
  let height = preflightDimensions?.height ?? 0;
  if (!preflightDimensions && (blob.type.startsWith("image/") || kind === "image")) {
    try {
      const dims = await readImageSize(url);
      width = dims.width;
      height = dims.height;
    } catch {
      // non-image blob under image kind
    }
  }

  return {
    url,
    storageKey,
    width,
    height,
    bytes: blob.size,
    mimeType: blob.type || "application/octet-stream",
    blob,
  };
}

function createStorageId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Fall through to a non-secret random identifier.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timeout = window.setTimeout(() => reject(new Error("Timed out reading image size")), 2_000);
    img.onload = () => {
      window.clearTimeout(timeout);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Failed to read image size"));
    };
    img.src = url;
  });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function storageKeyToDataUrl(
  kind: "image" | "media",
  storageKey: string,
): Promise<string | null> {
  const blob = await getBlob(kind, storageKey);
  if (!blob) return null;
  return blobToDataUrl(blob);
}

export async function downloadStorageKey(
  storageKey: string,
  filename: string,
): Promise<void> {
  const kind = mediaKindFromKey(storageKey);
  const blob = await getBlob(kind, storageKey);
  if (!blob) throw new Error("文件不存在");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function deleteStorageKey(storageKey: string): Promise<void> {
  const kind = mediaKindFromKey(storageKey);
  await deleteBlob(kind, storageKey);
  const url = objectUrls.get(storageKey);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(storageKey);
}

export async function validatePersistedPanoramaBlob(
  metadata: BoardNode["metadata"],
  blob: Blob,
): Promise<{ width: number; height: number }> {
  const dimensions = await readPanoramaBlobDimensions(blob);
  if ((metadata.bytes !== undefined && metadata.bytes !== blob.size) ||
      (metadata.mimeType !== undefined && metadata.mimeType !== blob.type) ||
      (metadata.naturalWidth !== undefined && metadata.naturalWidth !== dimensions.width) ||
      (metadata.naturalHeight !== undefined && metadata.naturalHeight !== dimensions.height)) {
    throw new Error("panorama metadata mismatch");
  }
  return dimensions;
}

export function repairInvalidPanoramaBatches(nodes: BoardNode[]): BoardNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ownerByChild = new Map<string, string>();
  const childIdsByRoot = new Map<string, string[]>();
  const usable = (node: BoardNode | undefined) => node?.type === "panorama" &&
    Boolean(node.metadata.content && node.metadata.storageKey && node.metadata.bytes &&
      node.metadata.panoramaProjection === "equirectangular");

  for (const root of nodes) {
    const declared = root.metadata.batchChildIds ?? [];
    if (declared.length === 0) continue;
    const valid = usable(root) ? declared.filter((childId) => {
      const child = byId.get(childId);
      return usable(child) && child?.metadata.batchRootId === root.id;
    }) : [];
    childIdsByRoot.set(root.id, valid);
    for (const childId of valid) ownerByChild.set(childId, root.id);
  }

  return nodes.map((node) => {
    const validChildren = childIdsByRoot.get(node.id);
    const validOwner = ownerByChild.get(node.id);
    if (validChildren) {
      return {
        ...node,
        metadata: validChildren.length > 0 ? {
          ...node.metadata,
          isBatchRoot: true,
          batchChildIds: validChildren,
          primaryImageId: node.id,
          count: validChildren.length + 1,
        } : {
          ...node.metadata,
          isBatchRoot: undefined,
          batchChildIds: undefined,
          primaryImageId: undefined,
          count: 1,
        },
      };
    }
    if (node.metadata.batchRootId && validOwner !== node.metadata.batchRootId) {
      return { ...node, metadata: { ...node.metadata, batchRootId: undefined } };
    }
    return node;
  });
}

/** Restore displayable blob: URLs after page reload. */
export async function rehydrateProjects(
  projects: BoardProject[],
): Promise<BoardProject[]> {
  const next: BoardProject[] = [];
  const migratedStorageKeys: string[] = [];
  for (const project of projects) {
    const nodes: BoardNode[] = [];
    try {
    for (const node of project.nodes) {
      let metadata = { ...node.metadata };
      if (metadata.storageKey) {
        const kind = mediaKindFromKey(metadata.storageKey);
        if (node.type === "panorama") {
          try {
            const blob = await getBlob(kind, metadata.storageKey);
            if (!blob) throw new Error("missing panorama blob");
            const dimensions = await validatePersistedPanoramaBlob(metadata, blob);
            const url = await resolveObjectUrl(kind, metadata.storageKey);
            if (!url) throw new Error("missing panorama object URL");
            metadata = {
              ...metadata,
              content: url,
              naturalWidth: dimensions.width,
              naturalHeight: dimensions.height,
              bytes: blob.size,
              mimeType: blob.type,
            };
          } catch {
            metadata = {
              ...metadata,
              content: undefined,
              status: "error",
              errorDetails: "全景媒体损坏或尺寸不匹配",
            };
          }
        } else {
          const url = await resolveObjectUrl(kind, metadata.storageKey, metadata.content);
          if (url) metadata = { ...metadata, content: url };
        }
      } else if (metadata.content?.startsWith("data:")) {
        try {
          const kind = node.type === "video" ? "media" : "image";
          const uploaded = await uploadMedia(metadata.content, kind, node.type === "panorama" ? {
            requirePersistent: true,
            preflightImage: readPanoramaBlobDimensions,
          } : undefined);
          metadata = {
            ...metadata,
            content: uploaded.url,
            storageKey: uploaded.storageKey,
            naturalWidth: uploaded.width || metadata.naturalWidth,
            naturalHeight: uploaded.height || metadata.naturalHeight,
            bytes: uploaded.bytes,
            mimeType: uploaded.mimeType,
          };
          migratedStorageKeys.push(uploaded.storageKey);
        } catch {
          if (node.type === "panorama") {
            metadata = {
              ...metadata,
              content: undefined,
              status: "error",
              errorDetails: "全景媒体损坏或尺寸不匹配",
            };
          }
          // Other legacy data URLs remain usable when migration fails.
        }
      }
      nodes.push({ ...node, metadata });
    }

    const chatSessions = [];
    for (const session of project.chatSessions) {
      const messages = [];
      for (const msg of session.messages) {
        const images = [];
        for (const img of msg.images ?? []) {
          if (img.storageKey) {
            const url = await resolveObjectUrl("image", img.storageKey, img.url);
            images.push({ ...img, url: url ?? img.url });
          } else if (img.url?.startsWith("data:")) {
            try {
              const uploaded = await uploadMedia(img.url, "image");
              images.push({
                ...img,
                url: uploaded.url,
                storageKey: uploaded.storageKey,
              });
              migratedStorageKeys.push(uploaded.storageKey);
            } catch {
              images.push(img);
            }
          } else {
            images.push(img);
          }
        }
        const references = [];
        for (const ref of msg.references ?? []) {
          if (ref.storageKey) {
            const kind = mediaKindFromKey(ref.storageKey);
            const url = await resolveObjectUrl(kind, ref.storageKey, ref.preview);
            references.push({ ...ref, preview: url ?? ref.preview });
          } else {
            references.push(ref);
          }
        }
        messages.push({
          ...msg,
          images: images.length ? images : msg.images,
          references: references.length ? references : msg.references,
        });
      }
      chatSessions.push({ ...session, messages });
    }

    const repairedNodes = repairInvalidPanoramaBatches(nodes);
    validateProjectPanoramaBudget(repairedNodes);
    next.push({ ...project, nodes: repairedNodes, chatSessions });
    } catch (error) {
      await Promise.allSettled(migratedStorageKeys.map((storageKey) => deleteStorageKey(storageKey)));
      throw error;
    }
  }
  return next;
}

export async function rehydrateAssets(assets: AssetItem[]): Promise<AssetItem[]> {
  const out: AssetItem[] = [];
  for (const asset of assets) {
    if (asset.storageKey) {
      const kind = mediaKindFromKey(asset.storageKey);
      const url = await resolveObjectUrl(kind, asset.storageKey, asset.coverUrl);
      out.push({ ...asset, coverUrl: url ?? asset.coverUrl });
    } else if (asset.coverUrl?.startsWith("data:")) {
      try {
        const uploaded = await uploadMedia(asset.coverUrl, "image");
        out.push({
          ...asset,
          coverUrl: uploaded.url,
          storageKey: uploaded.storageKey,
          mimeType: uploaded.mimeType,
        });
      } catch {
        out.push(asset);
      }
    } else {
      out.push(asset);
    }
  }
  return out;
}

export async function cropImageToBlob(
  sourceUrl: string,
  crop: { x: number; y: number; w: number; h: number },
): Promise<Blob> {
  const img = await loadHtmlImage(sourceUrl);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.w));
  canvas.height = Math.max(1, Math.round(crop.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Crop failed"))),
      "image/png",
    );
  });
}

export async function rotateImageToBlob(
  sourceUrl: string,
  degrees: number,
): Promise<Blob> {
  const img = await loadHtmlImage(sourceUrl);
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * cos + h * sin));
  canvas.height = Math.max(1, Math.round(w * sin + h * cos));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Rotate failed"))),
      "image/png",
    );
  });
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

export async function cleanupUnusedMedia(liveKeys: Set<string>): Promise<void> {
  for (const store of [imageStore, mediaStore]) {
    const all = await entries(store);
    for (const [key] of all) {
      const k = String(key);
      if (!liveKeys.has(k)) {
        await del(k, store);
        const url = objectUrls.get(k);
        if (url) {
          URL.revokeObjectURL(url);
          objectUrls.delete(k);
        }
      }
    }
  }
}

export function collectStorageKeys(
  projects: BoardProject[],
  assets: AssetItem[],
): Set<string> {
  const keys = new Set<string>();
  for (const p of projects) {
    for (const n of p.nodes) {
      if (n.metadata.storageKey) keys.add(n.metadata.storageKey);
      for (const storageKey of n.metadata.referenceStorageKeys ?? []) keys.add(storageKey);
    }
    for (const s of p.chatSessions) {
      for (const m of s.messages) {
        for (const img of m.images ?? []) {
          if (img.storageKey) keys.add(img.storageKey);
        }
        for (const r of m.references ?? []) {
          if (r.storageKey) keys.add(r.storageKey);
        }
      }
    }
  }
  for (const a of assets) {
    if (a.storageKey) keys.add(a.storageKey);
  }
  return keys;
}

export function collectBoardContentStorageKeys(
  nodes: readonly BoardNode[],
  chatSessions: readonly AssistantSession[],
): Set<string> {
  const keys = new Set<string>();
  for (const node of nodes) {
    if (node.metadata.storageKey) keys.add(node.metadata.storageKey);
    for (const storageKey of node.metadata.referenceStorageKeys ?? []) keys.add(storageKey);
  }
  for (const session of chatSessions) {
    for (const message of session.messages) {
      for (const image of message.images ?? []) if (image.storageKey) keys.add(image.storageKey);
      for (const reference of message.references ?? []) {
        if (reference.storageKey) keys.add(reference.storageKey);
      }
    }
  }
  return keys;
}
