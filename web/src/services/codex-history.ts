export type CodexHistoryStatus = "idle" | "running" | "completed" | "failed" | string;

export type CodexHistorySummary = {
  id: string;
  profile: string;
  threadId: string;
  title: string;
  preview?: string;
  createdAt: string;
  updatedAt: string;
  status: CodexHistoryStatus;
  messageCount: number;
};

export type CodexHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type CodexHistoryEvent = {
  sequence?: number;
  type: "notification" | "approval" | "error" | string;
  method?: string;
  id?: unknown;
  params?: unknown;
  data?: unknown;
};

export type CodexHistoryRecord = CodexHistorySummary & {
  cwd?: string;
  messages: CodexHistoryMessage[];
  events: CodexHistoryEvent[];
};

export function sortCodexHistory(records: readonly CodexHistorySummary[]): CodexHistorySummary[] {
  return records
    .map((record) => ({ ...record }))
    .sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated || right.id.localeCompare(left.id);
    });
}

export function normalizeCodexHistorySelection(
  records: readonly CodexHistorySummary[],
  selected: readonly string[],
): string[] {
  const requested = new Set(selected);
  return records.filter((record) => requested.has(record.id)).map((record) => record.id);
}

export function toggleCodexHistorySelection(
  selected: readonly string[],
  id: string,
  checked: boolean,
): string[] {
  const next = selected.filter((value) => value !== id);
  return checked ? [...next, id] : next;
}
