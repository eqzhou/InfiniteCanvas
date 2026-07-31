export type CodexProgressStatus = "running" | "completed" | "failed";

export type CodexProgressUpdate = {
  itemId?: string;
  itemType: string;
  label: string;
  detail?: string;
  appendDetail?: boolean;
  status: CodexProgressStatus;
  error?: string;
};

export type CodexProgressItem = {
  id: string;
  itemType: string;
  label: string;
  detail?: string;
  status: CodexProgressStatus;
  error?: string;
};

const MAX_PROGRESS_ITEMS = 48;

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
    ...(detail ? { detail } : {}),
    status: update.status,
    ...(update.error ? { error: update.error } : {}),
  };
  const merged = existing >= 0
    ? current.map((item, index) => index === existing ? { ...item, ...next } : item)
    : [...current, next];
  return merged.slice(-MAX_PROGRESS_ITEMS);
}

export function formatCodexElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`;
}
