import type { AiChannel, AiEndpointConfig, AppConfig, AssetItem, BoardProject, PromptItem } from "@/types/board";
import { stripObjectStorageSecrets } from "@/lib/object-storage";
import { isLoopbackHostname } from "@/lib/loopback-host";

export type BackupConfig = Omit<
  AppConfig,
  "channels" | "webdavUrl" | "webdavUser" | "webdavPass"
> & {
  channels: Array<Omit<AiChannel, "apiKey">>;
};

export type BackupBundle = {
  version: 1;
  exportedAt: string;
  projects: BoardProject[];
  assets: AssetItem[];
  prompts: PromptItem[];
  config: BackupConfig;
};

function authHeader(user?: string, pass?: string): string | undefined {
  if (!user && !pass) return undefined;
  const bytes = new TextEncoder().encode(`${user ?? ""}:${pass ?? ""}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function webdavBase(config: AppConfig): string {
  const raw = (config.webdavUrl ?? "").replace(/\/+$/, "");
  if (!raw) throw new Error("未配置 WebDAV URL");
  const url = new URL(raw);
  const localHTTP = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !localHTTP) {
    throw new Error("WebDAV 必须使用 HTTPS（localhost 除外）");
  }
  return raw;
}

async function limitedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > maxBytes) throw new Error("WebDAV response is too large");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("WebDAV response is too large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("WebDAV response is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function limitedResponseText(response: Response, maxBytes = 32 * 1024 * 1024): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await limitedResponseBytes(response, maxBytes),
  );
}

export async function webdavPut(
  config: AppConfig,
  path: string,
  body: string,
): Promise<void> {
  const base = webdavBase(config);
  const url = `${base}/${path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const auth = authHeader(config.webdavUser, config.webdavPass);
  if (auth) headers.Authorization = auth;
  const res = await fetch(url, { method: "PUT", headers, body, redirect: "error" });
  if (!res.ok) throw new Error(`WebDAV PUT ${res.status}`);
}

export async function webdavGet(
  config: AppConfig,
  path: string,
): Promise<string> {
  const base = webdavBase(config);
  const url = `${base}/${path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {};
  const auth = authHeader(config.webdavUser, config.webdavPass);
  if (auth) headers.Authorization = auth;
  const res = await fetch(url, { method: "GET", headers, redirect: "error" });
  if (!res.ok) throw new Error(`WebDAV GET ${res.status}`);
  return limitedResponseText(res);
}

export async function webdavPutBlob(
  config: AppConfig,
  path: string,
  body: Blob,
): Promise<void> {
  if (body.size > 128 * 1024 * 1024) throw new Error("WebDAV bundle is too large");
  const url = `${webdavBase(config)}/${path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = { "Content-Type": body.type || "application/zip" };
  const auth = authHeader(config.webdavUser, config.webdavPass);
  if (auth) headers.Authorization = auth;
  const response = await fetch(url, { method: "PUT", headers, body, redirect: "error" });
  if (!response.ok) throw new Error(`WebDAV PUT ${response.status}`);
}

export async function webdavGetBlob(config: AppConfig, path: string): Promise<Blob> {
  const url = `${webdavBase(config)}/${path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {};
  const auth = authHeader(config.webdavUser, config.webdavPass);
  if (auth) headers.Authorization = auth;
  const response = await fetch(url, { method: "GET", headers, redirect: "error" });
  if (!response.ok) throw new Error(`WebDAV GET ${response.status}`);
  const bytes = await limitedResponseBytes(response, 128 * 1024 * 1024);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: response.headers.get("Content-Type") ?? "application/zip" });
}

export function buildBackupBundle(input: {
  projects: BoardProject[];
  assets: AssetItem[];
  prompts: PromptItem[];
  config: AppConfig;
}): BackupBundle {
  const {
    webdavUrl: _webdavUrl,
    webdavUser: _webdavUser,
    webdavPass: _webdavPass,
    channels,
    ...preferences
  } = input.config;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    projects: input.projects,
    assets: input.assets,
    prompts: input.prompts,
    config: {
      ...preferences,
      objectStorage: preferences.objectStorage ? stripObjectStorageSecrets(preferences.objectStorage) : preferences.objectStorage,
      channels: channels.map(({ apiKey: _apiKey, ...channel }) => ({ ...channel, providers: channel.providers ? Object.fromEntries(Object.entries(channel.providers).map(([kind, provider]) => [kind, { ...provider, apiKey: "" }])) as typeof channel.providers : undefined })),
    },
  };
}

export function mergeBackupConfig(local: AppConfig, backup: BackupConfig): AppConfig {
  const localChannels = new Map(local.channels.map((channel) => [channel.id, channel]));
  const sameProviderRoute = (left: AiEndpointConfig, right: AiEndpointConfig | undefined) => Boolean(right && left.baseUrl === right.baseUrl &&
      (left.protocol ?? "openai") === (right.protocol ?? "openai") &&
      JSON.stringify(left.template ?? null) === JSON.stringify(right.template ?? null));
  return {
    ...backup,
    channels: backup.channels.map((channel) => {
      const local = localChannels.get(channel.id);
      const providers = channel.providers && local?.providers
        ? Object.fromEntries(Object.entries(channel.providers).map(([kind, provider]) => {
          const localProvider = local.providers?.[kind as keyof typeof local.providers];
          return [kind, { ...provider, apiKey: sameProviderRoute(provider, localProvider) ? localProvider?.apiKey ?? "" : "" }];
        })) as typeof channel.providers
        : channel.providers;
      const baseUrl = channel.baseUrl || local?.baseUrl || "";
      return { ...channel, providers, apiKey: local && baseUrl === local.baseUrl ? local.apiKey : "", baseUrl };
    }),
    webdavUrl: local.webdavUrl,
    webdavUser: local.webdavUser,
    webdavPass: local.webdavPass,
    objectStorage: local.objectStorage,
  };
}
