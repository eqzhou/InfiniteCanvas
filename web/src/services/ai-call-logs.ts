import { authFetch } from "@/services/auth-session";

export type AICallLog = {
  id: string;
  jobId?: string;
  userId?: string;
  kind: string;
  channelId?: string;
  channelName?: string;
  model?: string;
  protocol?: string;
  status: string;
  durationMs: number;
  error?: string;
  request?: unknown;
  response?: unknown;
  createdAt: string;
};

export type AICallLogPage = {
  items: AICallLog[];
  page: number;
  pageSize: number;
  total: number;
};

export type AICallLogQuery = {
  q?: string;
  kind?: string;
  status?: string;
  channel?: string;
  page?: number;
  pageSize?: number;
};

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listAICallLogs(query: AICallLogQuery = {}): Promise<AICallLogPage> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.kind?.trim()) params.set("kind", query.kind.trim());
  if (query.status?.trim()) params.set("status", query.status.trim());
  if (query.channel?.trim()) params.set("channel", query.channel.trim());
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const qs = params.toString();
  return readJSON<AICallLogPage>(await authFetch(`ai-call-logs${qs ? `?${qs}` : ""}`));
}

export async function getAICallLog(id: string): Promise<AICallLog> {
  return readJSON<AICallLog>(await authFetch(`ai-call-logs/${encodeURIComponent(id)}`));
}

export async function deleteAICallLogs(body: {
  ids?: string[];
  olderThanDays?: number;
  before?: string;
}): Promise<{ deleted: number }> {
  return readJSON<{ deleted: number }>(
    await authFetch("ai-call-logs/delete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
