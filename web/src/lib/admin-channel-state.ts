import type { AdminChannel } from "@/services/admin";

export interface AdminChannelModelDiff {
  added: string[];
  existing: string[];
  removed: string[];
  selected: string[];
}

function uniqueModelIds(models: readonly string[]): string[] {
  const seen = new Set<string>();
  return models.flatMap((rawModel) => {
    const model = rawModel.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key)) return [];
    seen.add(key);
    return [model];
  });
}

export function buildAdminChannelModelDiff(
  configuredModels: readonly string[],
  fetchedModels: readonly string[],
): AdminChannelModelDiff {
  const configured = uniqueModelIds(configuredModels);
  const fetched = uniqueModelIds(fetchedModels);
  const configuredIds = new Set(configured.map((model) => model.toLowerCase()));
  const fetchedIds = new Set(fetched.map((model) => model.toLowerCase()));

  return {
    added: fetched.filter((model) => !configuredIds.has(model.toLowerCase())),
    existing: fetched.filter((model) => configuredIds.has(model.toLowerCase())),
    removed: configured.filter((model) => !fetchedIds.has(model.toLowerCase())),
    selected: [...fetched],
  };
}

export function applyAdminChannelModelSelection(
  diff: AdminChannelModelDiff,
  selectedModels: readonly string[],
): string[] {
  const selected = new Set(uniqueModelIds(selectedModels).map((model) => model.toLowerCase()));
  return [...diff.selected, ...diff.removed].filter((model) => selected.has(model.toLowerCase()));
}

export function shouldDeleteAdminChannel(persistedIds: ReadonlySet<string>, channelId: string): boolean {
  return persistedIds.has(channelId);
}

export function mergeSavedAdminChannels(
  saved: readonly AdminChannel[],
): AdminChannel[] {
  return saved.map((channel) => ({
    ...channel,
    models: channel.models ? [...channel.models] : undefined,
  }));
}

export function adminChannelSecretBindingIsCurrent(
  channel: AdminChannel,
  persisted: AdminChannel | undefined,
): boolean {
  if (!persisted || !channel.secretBindingId?.trim()) return false;
  const modelsMatch = (channel.models ?? []).length === (persisted.models ?? []).length &&
    (channel.models ?? []).every((model, index) => model === (persisted.models ?? [])[index]);
  return channel.id === persisted.id &&
    channel.name === persisted.name &&
    channel.protocol === persisted.protocol &&
    channel.baseUrl === persisted.baseUrl &&
    channel.enabled === persisted.enabled &&
    channel.allowUserUse === persisted.allowUserUse &&
    channel.weight === persisted.weight &&
    channel.timeoutSeconds === persisted.timeoutSeconds &&
    modelsMatch &&
    channel.defaultTextModel === persisted.defaultTextModel &&
    channel.defaultImageModel === persisted.defaultImageModel &&
    channel.defaultVideoModel === persisted.defaultVideoModel &&
    channel.defaultAudioModel === persisted.defaultAudioModel &&
    channel.secretBindingId.trim() === persisted.secretBindingId?.trim();
}
