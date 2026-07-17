import { clear, createStore, del, entries, get, set } from "idb-keyval";
import type { AppConfig, AssetItem, BoardProject, PromptItem } from "@/types/board";
import { readBoundedResponse } from "@/services/remote-content";
import { normalizeExternalHttpsUrl } from "@/lib/remote-url";
import { normalizeChannel } from "@/lib/ai-config";
import { parseBoardProject } from "@/lib/board-document";
import {
  deleteServerBlob,
  getServerBlob,
  loadServerProjects,
  loadServerSecrets,
  loadServerState,
  putServerBlob,
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
      ...[...images, ...media].map(([key, value]) =>
        typeof key === "string" && value instanceof Blob
          ? putServerBlob(key, value)
          : Promise.resolve(),
      ),
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

type ConfigSecrets = {
  apiKeys: Record<string, Record<string, string>>;
  webdavPass: string;
};

export function sanitizeConfigForPersistence(config: AppConfig): AppConfig {
  return {
    ...config,
    channels: config.channels.map((channel) => {
      const n = normalizeChannel(channel);
      const p = n.providers!;
      return { ...n, apiKey: "", providers: { text: { ...p.text, apiKey: "" }, image: { ...p.image, apiKey: "" }, video: { ...p.video, apiKey: "" }, audio: { ...p.audio, apiKey: "" } } };
    }),
    webdavPass: "",
  };
}

function extractConfigSecrets(config: AppConfig): ConfigSecrets {
  return {
    apiKeys: Object.fromEntries(config.channels.map((channel) => {
      const p = normalizeChannel(channel).providers!;
      return [channel.id, { text: p.text.apiKey, image: p.image.apiKey, video: p.video.apiKey, audio: p.audio.apiKey }];
    })),
    webdavPass: config.webdavPass ?? "",
  };
}

function readSessionConfigSecrets(): ConfigSecrets {
  const empty: ConfigSecrets = { apiKeys: {}, webdavPass: "" };
  if (typeof sessionStorage === "undefined") return empty;
  try {
    const value = JSON.parse(sessionStorage.getItem(CONFIG_SECRETS_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const input = value as { apiKeys?: unknown; webdavPass?: unknown };
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
    ? (await loadServerSecrets<ConfigSecrets>()) ?? { apiKeys: {}, webdavPass: "" }
    : readSessionConfigSecrets();
  const persistedSecrets = extractConfigSecrets(stored);
  const secrets: ConfigSecrets = {
    apiKeys: { ...sessionSecrets.apiKeys },
    webdavPass: persistedSecrets.webdavPass || sessionSecrets.webdavPass,
  };
  for (const [id, keys] of Object.entries(persistedSecrets.apiKeys)) {
    if (keys && typeof keys === "object") secrets.apiKeys[id] = { ...(secrets.apiKeys[id] ?? {}), ...keys };
  }
  if (!SERVER_STORAGE) writeSessionConfigSecrets(secrets);

  const sanitized = sanitizeConfigForPersistence(stored);
  if (Object.values(persistedSecrets.apiKeys).some(Boolean) || persistedSecrets.webdavPass) {
    if (SERVER_STORAGE) await saveServerState("config", sanitized);
    else await set(CONFIG_KEY, sanitized, appStore);
  }
  return {
    ...sanitized,
    channels: sanitized.channels.map((raw) => {
      const channel = normalizeChannel(raw);
      const keys = secrets.apiKeys[channel.id] ?? {};
      const providers = Object.fromEntries(Object.entries(channel.providers!).map(([kind, provider]) => [kind, { ...provider, apiKey: keys[kind] ?? "" }])) as NonNullable<typeof channel.providers>;
      return { ...channel, providers, apiKey: providers.text.apiKey };
    }),
    webdavPass: secrets.webdavPass,
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
  await set(key, blob, kind === "image" ? imageStore : mediaStore);
}

export async function getBlob(
  kind: "image" | "media",
  key: string,
): Promise<Blob | undefined> {
  if (SERVER_STORAGE) return getServerBlob(key);
  return get<Blob>(key, kind === "image" ? imageStore : mediaStore);
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
): Promise<{
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}> {
  let blob: Blob;
  const maxBytes = kind === "image"
    ? MEDIA_UPLOAD_LIMITS.imageBytes
    : MEDIA_UPLOAD_LIMITS.mediaBytes;
  if (typeof input === "string") {
    if (input.startsWith("data:") || input.startsWith("blob:")) {
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

  const storageKey = `${kind}:${createStorageId()}`;
  let url: string;
  try {
    await putBlob(kind, storageKey, blob);
    url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
  } catch {
    // Some private/WebKit contexts reject Blob writes or object URLs. Keep the
    // current node usable with a data URL; persistence can be retried later.
    url = await blobToDataUrl(blob);
  }

  let width = 0;
  let height = 0;
  if (blob.type.startsWith("image/") || kind === "image") {
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

/** Restore displayable blob: URLs after page reload. */
export async function rehydrateProjects(
  projects: BoardProject[],
): Promise<BoardProject[]> {
  const next: BoardProject[] = [];
  for (const project of projects) {
    const nodes = [];
    for (const node of project.nodes) {
      let metadata = { ...node.metadata };
      if (metadata.storageKey) {
        const kind = mediaKindFromKey(metadata.storageKey);
        const url = await resolveObjectUrl(kind, metadata.storageKey, metadata.content);
        if (url) metadata = { ...metadata, content: url };
      } else if (metadata.content?.startsWith("data:")) {
        try {
          const kind = node.type === "video" ? "media" : "image";
          const uploaded = await uploadMedia(metadata.content, kind);
          metadata = {
            ...metadata,
            content: uploaded.url,
            storageKey: uploaded.storageKey,
            naturalWidth: uploaded.width || metadata.naturalWidth,
            naturalHeight: uploaded.height || metadata.naturalHeight,
            bytes: uploaded.bytes,
            mimeType: uploaded.mimeType,
          };
        } catch {
          // keep original data URL if migration fails
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

    next.push({ ...project, nodes, chatSessions });
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
