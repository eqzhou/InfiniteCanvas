export type PluginQuota = {
  windowStartedAt: number;
  messages: number;
  bytes: number;
  blocked: boolean;
};

export type PluginQuotaLimits = {
  maxMessages: number;
  maxBytes: number;
  windowMs: number;
};

export function createPluginQuota(now: number): PluginQuota {
  return { windowStartedAt: now, messages: 0, bytes: 0, blocked: false };
}

export function consumePluginQuota(
  quota: PluginQuota,
  now: number,
  bytes: number,
  limits: PluginQuotaLimits,
): { quota: PluginQuota; allowed: boolean } {
  if (quota.blocked) return { quota, allowed: false };
  const current = now - quota.windowStartedAt >= limits.windowMs
    ? createPluginQuota(now)
    : quota;
  const next: PluginQuota = {
    ...current,
    messages: current.messages + 1,
    bytes: current.bytes + Math.max(0, bytes),
  };
  if (next.messages > limits.maxMessages || next.bytes > limits.maxBytes) {
    return { quota: { ...next, blocked: true }, allowed: false };
  }
  return { quota: next, allowed: true };
}
