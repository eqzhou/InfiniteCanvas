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
  prior: readonly AdminChannel[],
): AdminChannel[] {
  const secretById = new Map(prior.map((channel) => [channel.id, channel.secretConfigured]));
  return saved.map((channel) => ({
    ...channel,
    secretConfigured: channel.secretConfigured || secretById.get(channel.id) || false,
  }));
}
