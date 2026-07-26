import type { AdminChannel } from "@/services/admin";

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
