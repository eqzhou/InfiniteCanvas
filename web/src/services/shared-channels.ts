import { useEffect, useMemo, useState } from "react";
import type { AiChannel, AiProtocol, AiProviderKind } from "@/types/board";
import { getProvider } from "@/lib/ai-config";
import { audioProtocolRequiresKey } from "@/lib/audio-provider";
import { authFetch } from "@/services/auth-session";

export type SharedChannel = {
  id: string;
  name: string;
  protocol: Exclude<AiProtocol, "ark" | "template">;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  defaultAudioModel?: string;
  /** Optional allow-list published by admins; never includes secrets. */
  models?: string[];
};

const managedBaseUrl = "https://server-managed.invalid/v1";
const managedCredential = "server-managed";
const sharedChannelCatalogTtlMs = 30_000;
let sharedChannelCatalogCache: { promise: Promise<SharedChannel[]>; expiresAt: number } | null = null;
let sharedChannelCatalogSnapshot: SharedChannel[] = [];
let sharedChannelRefreshGeneration = 0;
let sharedChannelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const sharedChannelListeners = new Set<(channels: SharedChannel[]) => void>();

export async function listSharedChannels(): Promise<SharedChannel[]> {
  const response = await authFetch("shared-channels");
  if (!response.ok) throw new Error((await response.text().catch(() => "")) || "共享渠道目录加载失败");
  return response.json() as Promise<SharedChannel[]>;
}

export function sharedChannelAsAI(channel: SharedChannel): AiChannel {
  const models = Array.isArray(channel.models)
    ? channel.models.map((model) => model.trim()).filter(Boolean)
    : [];
  const endpoint = (model: string | undefined) => ({
    baseUrl: managedBaseUrl,
    apiKey: model === undefined && channel.id !== "shared-auto" ? "" : managedCredential,
    model: model ?? "",
    protocol: channel.protocol,
    ...(models.length ? { models: [...models] } : {}),
  });
  return {
    id: channel.id, name: channel.name, baseUrl: managedBaseUrl, apiKey: managedCredential,
    defaultTextModel: "", defaultImageModel: channel.defaultImageModel ?? "",
    defaultVideoModel: channel.defaultVideoModel ?? "", defaultAudioModel: channel.defaultAudioModel ?? "",
    providers: {
      text: { baseUrl: "", apiKey: "", model: "", protocol: "openai", ...(models.length ? { models: [...models] } : {}) },
      image: endpoint(channel.defaultImageModel), video: endpoint(channel.defaultVideoModel),
      audio: endpoint(channel.defaultAudioModel),
    },
  };
}

export function isServerManagedChannel(channel: AiChannel, kind: AiProviderKind): boolean {
  return getProvider(channel, kind).apiKey === managedCredential;
}

export function isGenerationChannelReady(channel: AiChannel | undefined, kind: AiProviderKind): channel is AiChannel {
  if (!channel) return false;
  if (isServerManagedChannel(channel, kind)) return true;
  const provider = getProvider(channel, kind);
  return kind === "audio" && !audioProtocolRequiresKey(provider.protocol)
    ? true
    : Boolean(provider.apiKey.trim());
}

export function invalidateSharedChannelCatalog(): void {
	sharedChannelRefreshGeneration += 1;
  sharedChannelCatalogCache = null;
  if (sharedChannelListeners.size) void refreshSharedChannelCatalog();
}

// Shared-channel metadata is tenant scoped. Any credential/scope change must
// drop the cached catalog before the next tenant can observe it, otherwise a
// fast re-login would render the previous tenant's channel names and models.
export function resetSharedChannelCatalog(): void {
  sharedChannelRefreshGeneration += 1;
  sharedChannelCatalogCache = null;
  sharedChannelCatalogSnapshot = [];
  if (sharedChannelRefreshTimer) {
    clearTimeout(sharedChannelRefreshTimer);
    sharedChannelRefreshTimer = null;
  }
  for (const listener of sharedChannelListeners) listener([]);
  if (sharedChannelListeners.size) void refreshSharedChannelCatalog().catch(() => {});
}

export function loadSharedChannelsCached(
  loader: () => Promise<SharedChannel[]> = listSharedChannels,
  now = Date.now(),
): Promise<SharedChannel[]> {
  if (sharedChannelCatalogCache && sharedChannelCatalogCache.expiresAt > now) {
    return sharedChannelCatalogCache.promise;
  }
  const promise = loader().catch((error) => {
    if (sharedChannelCatalogCache?.promise === promise) sharedChannelCatalogCache = null;
    throw error;
  });
  sharedChannelCatalogCache = { promise, expiresAt: now + sharedChannelCatalogTtlMs };
  return promise;
}

export async function refreshSharedChannelCatalog(
  loader: () => Promise<SharedChannel[]> = listSharedChannels,
): Promise<void> {
	const generation = ++sharedChannelRefreshGeneration;
  const channels = await loadSharedChannelsCached(loader);
	if (generation !== sharedChannelRefreshGeneration) return;
  sharedChannelCatalogSnapshot = channels;
  for (const listener of sharedChannelListeners) listener(channels);
  if (sharedChannelRefreshTimer) clearTimeout(sharedChannelRefreshTimer);
  sharedChannelRefreshTimer = setTimeout(() => {
    sharedChannelCatalogCache = null;
    if (sharedChannelListeners.size) void refreshSharedChannelCatalog().catch(() => {});
  }, sharedChannelCatalogTtlMs);
}

export function getSharedChannelCatalogSnapshot(): SharedChannel[] {
	return [...sharedChannelCatalogSnapshot];
}

export function mergeSharedChannelChoices(personal: readonly AiChannel[], shared: readonly SharedChannel[]): AiChannel[] {
  const personalIds = new Set(personal.map((channel) => channel.id));
  return [...personal, ...shared.filter((channel) => !personalIds.has(channel.id)).map(sharedChannelAsAI)];
}

export function resolveActiveAIChannel(
  personal: readonly AiChannel[],
  activePersonalId: string | null | undefined,
  shared: readonly SharedChannel[],
  activeSharedId: string | null | undefined,
): AiChannel | undefined {
  if (activeSharedId) {
    const selectedShared = shared.find((channel) => channel.id === activeSharedId);
    if (selectedShared) return sharedChannelAsAI(selectedShared);
		return undefined;
  }
  return personal.find((channel) => channel.id === activePersonalId) ?? personal[0];
}

export function useSharedChannels(): SharedChannel[] {
  const [channels, setChannels] = useState<SharedChannel[]>(sharedChannelCatalogSnapshot);
  useEffect(() => {
    let active = true;
    const update = (items: SharedChannel[]) => { if (active) setChannels(items); };
    sharedChannelListeners.add(update);
    void refreshSharedChannelCatalog().catch(() => {});
    return () => {
      active = false;
      sharedChannelListeners.delete(update);
      if (!sharedChannelListeners.size && sharedChannelRefreshTimer) {
        clearTimeout(sharedChannelRefreshTimer);
        sharedChannelRefreshTimer = null;
      }
    };
  }, []);
  return useMemo(() => channels, [channels]);
}
