import { parsePluginManifest } from "@/lib/plugin-runtime";
import type { PluginManifest } from "@/types/board";

const MAX_MANIFEST_BYTES = 640 * 1024;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
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
      if (bytes > MAX_MANIFEST_BYTES) {
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

export async function fetchPluginManifest(
  source: string,
  fetcher: Fetcher = fetch,
): Promise<PluginManifest> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("plugin manifest URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("plugin manifest URL must use HTTPS");
  if (url.username || url.password) throw new Error("plugin manifest URL must not include credentials");
  if (url.hash) throw new Error("plugin manifest URL must not include a fragment");

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

export function installPluginManifest(
  installed: readonly PluginManifest[],
  candidate: PluginManifest,
): PluginManifest[] {
  const parsed = parsePluginManifest(candidate);
  const current = installed.find((plugin) => plugin.id === parsed.id);
  if (current?.version === parsed.version) {
    throw new Error(`${parsed.name} ${parsed.version} is already installed`);
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
