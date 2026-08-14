import { parsePluginManifest } from "@/lib/plugin-runtime";
import type {
  AppConfig,
  PluginManifest,
  PluginRegistry,
  PluginRegistryEntry,
} from "@/types/board";

const MAX_MANIFEST_BYTES = 640 * 1024;
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_REGISTRY_ENTRIES = 500;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function readBoundedBody(
  response: Response,
  maxBytes = MAX_MANIFEST_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("plugin manifest is too large");
  }
  if (!response.body) throw new Error("plugin manifest response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("plugin manifest is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function httpsUrl(source: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} URL must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} URL must not include credentials`);
  if (url.hash) throw new Error(`${label} URL must not include a fragment`);
  return url;
}

function registryString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export async function fetchPluginManifest(
  source: string,
  fetcher: Fetcher = fetch,
): Promise<PluginManifest> {
  const url = httpsUrl(source, "plugin manifest");

  const response = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json" },
  });
  if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
    throw new Error("plugin manifest redirect is not allowed");
  }
  if (!response.ok) throw new Error(`plugin manifest request failed (${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json" && contentType !== "application/manifest+json") {
    throw new Error("plugin manifest response must be JSON");
  }
  const body = await readBoundedBody(response);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("plugin manifest contains invalid JSON");
  }
  return parsePluginManifest(value);
}

export async function fetchPluginRegistry(
  source: string,
  fetcher: Fetcher = fetch,
): Promise<PluginRegistry> {
  const url = httpsUrl(source, "plugin registry");
  const response = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json" },
  });
  if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
    throw new Error("plugin registry redirect is not allowed");
  }
  if (!response.ok) throw new Error(`plugin registry request failed (${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new Error("plugin registry response must be JSON");
  const parsed = JSON.parse(await readBoundedBody(response, MAX_REGISTRY_BYTES)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("plugin registry must be an object");
  }
  const input = parsed as Record<string, unknown>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.plugins) || input.plugins.length > MAX_REGISTRY_ENTRIES) {
    throw new Error("plugin registry schema is invalid");
  }
  const ids = new Set<string>();
  const plugins = input.plugins.map((value): PluginRegistryEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("plugin registry entry is invalid");
    }
    const entry = value as Record<string, unknown>;
    const id = registryString(entry.id, "plugin registry id", 128);
    if (!PLUGIN_ID_PATTERN.test(id)) throw new Error("plugin registry id is invalid");
    if (ids.has(id)) throw new Error("plugin registry contains duplicate ids");
    ids.add(id);
    const version = registryString(entry.version, "plugin registry version", 64);
    comparePluginVersions(version, version);
    return {
      id,
      name: registryString(entry.name, "plugin registry name", 100),
      version,
      description: registryString(entry.description, "plugin registry description", 500),
      manifestUrl: httpsUrl(
        registryString(entry.manifestUrl, "plugin registry manifestUrl", 2_048),
        "plugin manifest",
      ).toString(),
    };
  });
  return { schemaVersion: 1, plugins };
}

export function comparePluginVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) throw new Error("plugin version is invalid");
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return difference;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export async function persistPluginUpgrade(
  installed: readonly PluginManifest[],
  candidate: PluginManifest,
  persist: (plugins: PluginManifest[]) => Promise<void>,
): Promise<PluginManifest[]> {
  const upgraded = installPluginManifest(installed, candidate);
  try {
    await persist(upgraded);
    return upgraded;
  } catch (error) {
    await persist([...installed]);
    throw error;
  }
}

export async function persistPluginConfigChange(
  current: AppConfig,
  next: AppConfig,
  persist: (config: AppConfig) => Promise<void>,
): Promise<void> {
  try {
    await persist(next);
  } catch (error) {
    try {
      await persist(current);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "plugin configuration persistence failed and rollback failed",
      );
    }
    throw error;
  }
}

export function installPluginManifest(
  installed: readonly PluginManifest[],
  candidate: PluginManifest,
): PluginManifest[] {
  const parsed = parsePluginManifest(candidate);
  const current = installed.find((plugin) => plugin.id === parsed.id);
  if (current?.version === parsed.version) {
    throw new Error(`${parsed.name} ${parsed.version} is already installed`);
  }
  if (current && comparePluginVersions(parsed.version, current.version) < 0) {
    throw new Error(`${parsed.name} cannot be downgraded`);
  }
  return current
    ? installed.map((plugin) => plugin.id === parsed.id ? parsed : plugin)
    : [...installed, parsed];
}

export function uninstallPluginManifest(
  installed: readonly PluginManifest[],
  pluginId: string,
): PluginManifest[] {
  return installed.filter((plugin) => plugin.id !== pluginId);
}

export function normalizePluginManifests(value: unknown): PluginManifest[] {
  if (!Array.isArray(value)) return [];
  const manifests = new Map<string, PluginManifest>();
  for (const candidate of value) {
    try {
      const parsed = parsePluginManifest(candidate);
      manifests.set(parsed.id, parsed);
    } catch {
      // A malformed persisted entry must not prevent the rest of the app from hydrating.
    }
  }
  return [...manifests.values()];
}

export function enabledPluginManifests(
  installed: readonly PluginManifest[],
  disabledPluginIds: readonly string[] = [],
): PluginManifest[] {
  const disabled = new Set(disabledPluginIds);
  return installed.filter((plugin) => !disabled.has(plugin.id));
}

export function setPluginEnabled(
  disabledPluginIds: readonly string[],
  pluginId: string,
  enabled: boolean,
): string[] {
  if (enabled) return disabledPluginIds.filter((id) => id !== pluginId);
  return disabledPluginIds.includes(pluginId)
    ? [...disabledPluginIds]
    : [...disabledPluginIds, pluginId];
}
