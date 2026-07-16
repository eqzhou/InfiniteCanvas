import type { BoardProject } from "@/types/board";
import { parseBoardProject } from "@/lib/board-document";
import { readBoundedResponse } from "@/services/remote-content";

export type SyncDirection = "push" | "pull" | "none";

export const DEFAULT_AGENT_BASE_URL = "http://127.0.0.1:8790";

export type AgentConnection = {
  baseUrl: string;
  token?: string;
};

export type AgentStatus = {
  connected: boolean;
  bridges?: string[];
  message?: string;
  tools?: string[];
};

export type CodexSession = { id: string; threadId?: string };
export type CodexEvent = {
  type: "notification" | "approval" | "error";
  method?: string;
  id?: unknown;
  params?: unknown;
  data?: unknown;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function parseCodexSseRecords(
  input: string,
  flush = false,
): { events: CodexEvent[]; remainder: string } {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = flush ? "" : (parts.pop() ?? "");
  const events: CodexEvent[] = [];
  for (const record of flush ? parts.concat(remainder ? [remainder] : []) : parts) {
    const data = record
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const value = JSON.parse(data) as CodexEvent;
      if (value && typeof value === "object") events.push(value);
    } catch {
      // Ignore malformed event payloads while keeping the stream alive.
    }
  }
  return { events, remainder };
}

export function normalizeAgentBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Agent URL is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Agent URL must use HTTPS unless it is loopback");
  }
  if (url.username || url.password) throw new Error("Agent URL must not include credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Agent URL must contain only an origin");
  }
  return url.origin;
}

async function agentFetch(
  connection: AgentConnection,
  path: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const baseUrl = normalizeAgentBaseUrl(connection.baseUrl || DEFAULT_AGENT_BASE_URL);
  const headers = new Headers(init.headers);
  if (connection.token) headers.set("Authorization", `Bearer ${connection.token}`);
  return fetcher(`${baseUrl}/${path.replace(/^\/+/, "")}`, {
    ...init,
    headers,
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
}

async function boundedJSON(response: Response, maxBytes: number): Promise<unknown> {
  const { bytes } = await readBoundedResponse(response, {
    maxBytes,
    mimeTypes: ["application/json"],
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Agent returned invalid JSON");
  }
}

export async function createCodexSession(
  connection: AgentConnection,
  cwd?: string,
  fetcher: Fetcher = fetch,
): Promise<CodexSession> {
  const response = await agentFetch(connection, "api/codex/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cwd ? { cwd } : {}),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex session failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 64 * 1024);
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new Error("Agent returned an invalid Codex session");
  }
  return value as CodexSession;
}

export async function sendCodexMessage(
  connection: AgentConnection,
  sessionId: string,
  text: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await agentFetch(connection, "api/codex/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex message failed: HTTP ${response.status}`);
}

export async function respondCodexApproval(
  connection: AgentConnection,
  sessionId: string,
  id: unknown,
  approve: boolean,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await agentFetch(connection, "api/codex/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, id, approve }),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex approval failed: HTTP ${response.status}`);
}

export function subscribeCodexEvents(
  connection: AgentConnection,
  sessionId: string,
  onEvent: (event: CodexEvent) => void,
  onError?: (error: Error) => void,
): { close: () => void } {
  const baseUrl = normalizeAgentBaseUrl(connection.baseUrl || DEFAULT_AGENT_BASE_URL);
  const controller = new AbortController();
  const headers = new Headers();
  if (connection.token) headers.set("Authorization", `Bearer ${connection.token}`);
  void fetch(`${baseUrl}/api/codex/events?sessionId=${encodeURIComponent(sessionId)}`, {
    headers,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok || !response.body) throw new Error(`Codex event stream failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseCodexSseRecords(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) onEvent(event);
    }
    const parsed = parseCodexSseRecords(buffer, true);
    for (const event of parsed.events) onEvent(event);
  }).catch((error: unknown) => {
    if (!controller.signal.aborted) onError?.(error instanceof Error ? error : new Error("codex stream error"));
  });
  return { close: () => controller.abort() };
}

export async function closeCodexSession(
  connection: AgentConnection,
  sessionId: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await agentFetch(connection, `api/codex/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, fetcher);
  if (!response.ok && response.status !== 404) throw new Error(`Codex close failed: HTTP ${response.status}`);
}

export async function fetchAgentStatus(
  connection: AgentConnection,
  fetcher: Fetcher = fetch,
): Promise<AgentStatus> {
  const response = await agentFetch(connection, "api/agent/status", { method: "GET" }, fetcher);
  if (!response.ok) throw new Error(`Agent status failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 256 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof (value as { connected?: unknown }).connected !== "boolean") {
    throw new Error("Agent returned an invalid status response");
  }
  return value as AgentStatus;
}

export function decideProjectSync(localUpdatedAt: string, remoteUpdatedAt: string): SyncDirection {
  const local = Date.parse(localUpdatedAt);
  const remote = Date.parse(remoteUpdatedAt);
  if (!Number.isFinite(local) || !Number.isFinite(remote) || local === remote) return "none";
  return remote > local ? "pull" : "push";
}

export async function pushProjectToAgent(
  project: BoardProject,
  connection: AgentConnection = { baseUrl: DEFAULT_AGENT_BASE_URL },
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await agentFetch(connection, `api/projects/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  }, fetcher);
  if (!response.ok) throw new Error(`Agent project push failed: HTTP ${response.status}`);
}

export async function syncProjectWithAgent(
  local: BoardProject,
  getCurrent?: () => BoardProject | undefined,
  connection: AgentConnection = { baseUrl: DEFAULT_AGENT_BASE_URL },
  fetcher: Fetcher = fetch,
): Promise<{ direction: SyncDirection; project?: BoardProject }> {
  const response = await agentFetch(
    connection,
    `api/projects/${encodeURIComponent(local.id)}`,
    { method: "GET" },
    fetcher,
  );
  if (response.status === 404) {
    const current = getCurrent?.();
    if (current && current.updatedAt !== local.updatedAt) return { direction: "none" };
    await pushProjectToAgent(local, connection, fetcher);
    return { direction: "push" };
  }
  if (!response.ok) throw new Error(`Agent project read failed: HTTP ${response.status}`);
  const remote = parseBoardProject(await boundedJSON(response, 64 * 1024 * 1024));
  const current = getCurrent?.();
  if (current && current.updatedAt !== local.updatedAt) return { direction: "none" };
  const direction = decideProjectSync(local.updatedAt, remote.updatedAt);
  if (direction === "push") await pushProjectToAgent(local, connection, fetcher);
  return direction === "pull" ? { direction, project: remote } : { direction };
}
