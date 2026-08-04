export type CodexProgressStatus = "running" | "completed" | "failed";

export type CodexProgressUpdate = {
  itemId?: string;
  itemType: string;
  label: string;
  path?: string;
  detail?: string;
  appendDetail?: boolean;
  status: CodexProgressStatus;
  error?: string;
};

export type CodexProgressItem = {
  id: string;
  itemType: string;
  label: string;
  path?: string;
  detail?: string;
  status: CodexProgressStatus;
  error?: string;
};

const MAX_PROGRESS_ITEMS = 48;
const MAX_LOG_ITEMS = 100;

function progressIdentity(update: CodexProgressUpdate): string {
  return update.itemId
    ?? `${update.itemType}:${update.detail ?? update.label}`;
}

export function reduceCodexProgress(
  current: readonly CodexProgressItem[],
  update: CodexProgressUpdate,
): CodexProgressItem[] {
  const id = progressIdentity(update);
  const existing = current.findIndex((item) => item.id === id);
  const prior = existing >= 0 ? current[existing] : undefined;
  const detail = update.appendDetail && prior?.detail
    ? `${prior.detail}${update.detail ?? ""}`.slice(-8_000)
    : update.detail;
  const next: CodexProgressItem = {
    id,
    itemType: update.itemType,
    label: update.label,
    ...(update.path ? { path: update.path } : {}),
    ...(detail ? { detail } : {}),
    status: update.status,
    ...(update.error ? { error: update.error } : {}),
  };
  const merged = existing >= 0
    ? current.map((item, index) => index === existing ? { ...item, ...next } : item)
    : [...current, next];
  return merged.slice(-MAX_PROGRESS_ITEMS);
}

export function mergeCodexProgress(
  history: readonly CodexProgressItem[],
  live: readonly CodexProgressItem[],
): CodexProgressItem[] {
  let merged = history.map((item) => ({ ...item }));
  for (const current of live) {
    const index = merged.findIndex((item) => item.id === current.id);
    const next = { ...current };
    merged = index >= 0
      ? merged.map((item, itemIndex) => itemIndex === index ? next : item)
      : [...merged, next];
  }
  return merged.slice(-MAX_PROGRESS_ITEMS);
}

export function mergeCodexLogs(
  history: readonly string[],
  live: readonly string[],
): string[] {
  const durable = history.slice(-MAX_LOG_ITEMS);
  const current = live.slice(-MAX_LOG_ITEMS);
  if (!durable.length) return current;
  if (!current.length) return durable;
  const startsWithDurable = durable.length <= current.length && durable.every((entry, index) => entry === current[index]);
  if (startsWithDurable) return current;
  const endsWithCurrent = current.length <= durable.length && current.every((entry, index) => entry === durable[durable.length - current.length + index]);
  if (endsWithCurrent) return durable;
  return [...durable, ...current].slice(-MAX_LOG_ITEMS);
}

export function formatCodexElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`;
}
