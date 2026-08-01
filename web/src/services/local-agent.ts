import type { BoardProject } from "@/types/board";
import { parseBoardProject } from "@/lib/board-document";
import { readBoundedResponse } from "@/services/remote-content";
import { getSessionToken } from "@/services/auth-session";
import type {
  CodexHistoryEvent,
  CodexHistoryMessage,
  CodexHistoryRecord,
  CodexHistorySummary,
} from "./codex-history";

export type {
  CodexHistoryEvent,
  CodexHistoryMessage,
  CodexHistoryRecord,
  CodexHistorySummary,
} from "./codex-history";

export type SyncDirection = "push" | "pull" | "none";

export const DEFAULT_AGENT_BASE_URL = "http://127.0.0.1:8790";
export const AGENT_TOKEN_KEY = "openboard:agent-token";
export const AGENT_CONNECTION_CHANGE_EVENT = "openboard:agent-connection-change";
let volatileAgentToken = "";

export function readAgentToken(): string {
  try {
    return sessionStorage.getItem(AGENT_TOKEN_KEY) ?? volatileAgentToken;
  } catch {
    return volatileAgentToken;
  }
}

export function saveAgentToken(token: string): void {
  volatileAgentToken = token;
  try {
    if (token) sessionStorage.setItem(AGENT_TOKEN_KEY, token);
    else sessionStorage.removeItem(AGENT_TOKEN_KEY);
  } catch {
    // The process-local value keeps the current tab connected when storage is unavailable.
  }
  window.dispatchEvent(new Event(AGENT_CONNECTION_CHANGE_EVENT));
}

export function resolveAgentBaseUrl(configured: string | undefined, token: string, pageOrigin: string): string {
  const baseUrl = configured || DEFAULT_AGENT_BASE_URL;
  return (!token || getSessionToken()) && baseUrl === DEFAULT_AGENT_BASE_URL ? pageOrigin : baseUrl;
}

export type AgentConnection = {
  baseUrl: string;
  token?: string;
};

export function agentAuthHeaders(connection: AgentConnection, initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  const agentUrl = new URL(normalizeAgentBaseUrl(connection.baseUrl || DEFAULT_AGENT_BASE_URL));
  const pageOrigin = typeof location !== "undefined" ? location.origin : "";
  const sameOrigin = pageOrigin !== "" && agentUrl.origin === pageOrigin;
  if (connection.token && !sameOrigin) headers.set("Authorization", `Bearer ${connection.token}`);
  const sessionToken = sameOrigin ? getSessionToken() : null;
  if (sessionToken) headers.set("X-OpenBoard-Session", sessionToken);
  return headers;
}

export type AgentStatus = {
  connected: boolean;
  runtime?: { connected?: boolean };
  bridges?: string[];
  message?: string;
  tools?: string[];
  codex?: { available?: boolean; sessionEndpoint?: string; eventsEndpoint?: string };
  claude?: { available?: boolean; sessionEndpoint?: string; eventsEndpoint?: string; binary?: string };
};

export type CodexSession = {
  id: string;
  threadId?: string;
  historyId?: string;
  profile?: string;
  reused?: boolean;
  running?: boolean;
  runtimeClientId?: string;
  model?: string;
  effort?: string;
};
export type CodexReasoningEffort = {
  reasoningEffort: string;
  description: string;
};
export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  isDefault: boolean;
};
export type CodexAttachment = {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
};
export type CodexEvent = {
  sequence?: number;
  type: "notification" | "approval" | "error";
  method?: string;
  id?: unknown;
  params?: unknown;
  data?: unknown;
};
export type CodexPermissionMode = "read-only" | "workspace-auto" | "full-access";
export type SendCodexMessageOptions = {
  attachmentIds?: string[];
  clientId?: string;
  clientMessageId?: string;
  permissionMode?: CodexPermissionMode;
  model?: string;
  effort?: string;
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
  const headers = agentAuthHeaders(connection, init.headers);
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

const CODEX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validateCodexHistorySummary(value: unknown): CodexHistorySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent returned an invalid Codex history record");
  }
  const record = value as Partial<CodexHistorySummary>;
  if (!CODEX_ID_PATTERN.test(record.id ?? "") || !CODEX_ID_PATTERN.test(record.profile ?? "") ||
      typeof record.threadId !== "string" || record.threadId !== "" && !CODEX_ID_PATTERN.test(record.threadId) ||
      typeof record.title !== "string" || !record.title || record.title.length > 256 ||
      typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" ||
      typeof record.status !== "string" || typeof record.messageCount !== "number" ||
      !Number.isSafeInteger(record.messageCount) || record.messageCount < 0 || record.messageCount > 512 ||
      record.preview !== undefined && typeof record.preview !== "string") {
    throw new Error("Agent returned an invalid Codex history record");
  }
  const id = record.id ?? "";
  const profile = record.profile ?? "";
  return {
    id,
    profile,
    threadId: record.threadId,
    title: record.title,
    ...(record.preview ? { preview: record.preview } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    messageCount: record.messageCount,
  };
}

function validateCodexHistoryRecord(value: unknown): CodexHistoryRecord {
  const summary = validateCodexHistorySummary(value);
  const record = value as Partial<CodexHistoryRecord>;
  if (!Array.isArray(record.messages) || record.messages.length > 512 ||
      !record.messages.every((message) => message && typeof message === "object" &&
        CODEX_ID_PATTERN.test((message as CodexHistoryMessage).id) &&
        ((message as CodexHistoryMessage).role === "user" || (message as CodexHistoryMessage).role === "assistant") &&
        typeof (message as CodexHistoryMessage).text === "string" && (message as CodexHistoryMessage).text.length <= 100_000 &&
        typeof (message as CodexHistoryMessage).createdAt === "string") ||
      !Array.isArray(record.events) || record.events.length > 2_048) {
    throw new Error("Agent returned an invalid Codex history transcript");
  }
  return {
    ...summary,
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    messages: record.messages as CodexHistoryMessage[],
    events: record.events as CodexHistoryEvent[],
  };
}

function validateCodexHistoryID(id: string): void {
  if (!CODEX_ID_PATTERN.test(id)) throw new Error("Codex history id is invalid");
}

export async function createCodexSession(
  connection: AgentConnection,
  cwdOrOptions?: string | { cwd?: string; profile?: string; fresh?: boolean },
  fetcher: Fetcher = fetch,
): Promise<CodexSession> {
  const options = typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : (cwdOrOptions ?? {});
  const response = await agentFetch(connection, "api/codex/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex session failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 64 * 1024);
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new Error("Agent returned an invalid Codex session");
  }
  return value as CodexSession;
}

export async function getCodexSession(
  connection: AgentConnection,
  profile = "default",
  fetcher: Fetcher = fetch,
): Promise<CodexSession | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profile)) throw new Error("Codex profile is invalid");
  const response = await agentFetch(connection, `api/codex/session?profile=${encodeURIComponent(profile)}`, {
    method: "GET",
  }, fetcher);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Codex session status failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 64 * 1024);
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string" ||
      typeof (value as { running?: unknown }).running !== "boolean") {
    throw new Error("Agent returned an invalid Codex session status");
  }
  return value as CodexSession;
}

function validateCodexPickerValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 128 || value.trim() !== value ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`Agent returned an invalid Codex ${label}`);
  }
  return value;
}

export async function listCodexModels(
  connection: AgentConnection,
  sessionId: string,
  fetcher: Fetcher = fetch,
): Promise<CodexModel[]> {
  if (!CODEX_ID_PATTERN.test(sessionId)) throw new Error("Codex session is invalid");
  const response = await agentFetch(
    connection,
    `api/codex/models?sessionId=${encodeURIComponent(sessionId)}`,
    { method: "GET" },
    fetcher,
  );
  if (!response.ok) throw new Error(`Codex model list failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 512 * 1024);
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data) || data.length > 200) {
    throw new Error("Agent returned an invalid Codex model list");
  }
  const seenIds = new Set<string>();
  const seenModels = new Set<string>();
  return data.map((raw): CodexModel => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Agent returned an invalid Codex model");
    }
    const item = raw as Partial<CodexModel>;
    const id = validateCodexPickerValue(item.id, "model id");
    const model = validateCodexPickerValue(item.model, "model name");
    if (seenIds.has(id) || seenModels.has(model)) {
      throw new Error("Agent returned duplicate Codex models");
    }
    seenIds.add(id);
    seenModels.add(model);
    if (typeof item.displayName !== "string" || !item.displayName.trim() || item.displayName.length > 160 ||
        typeof item.description !== "string" || item.description.length > 2_000 ||
        typeof item.isDefault !== "boolean" || !Array.isArray(item.supportedReasoningEfforts) ||
        item.supportedReasoningEfforts.length > 32) {
      throw new Error("Agent returned an invalid Codex model");
    }
    const seenEfforts = new Set<string>();
    const efforts = item.supportedReasoningEfforts.map((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option) ||
          typeof option.description !== "string" || option.description.length > 500) {
        throw new Error("Agent returned an invalid Codex reasoning effort");
      }
      const reasoningEffort = validateCodexPickerValue(option.reasoningEffort, "reasoning effort");
      if (seenEfforts.has(reasoningEffort)) {
        throw new Error("Agent returned duplicate Codex reasoning efforts");
      }
      seenEfforts.add(reasoningEffort);
      return {
        reasoningEffort,
        description: option.description,
      };
    });
    const defaultReasoningEffort = validateCodexPickerValue(
      item.defaultReasoningEffort,
      "default reasoning effort",
    );
    if (efforts.length && !efforts.some((option) => option.reasoningEffort === defaultReasoningEffort)) {
      throw new Error("Agent returned an unavailable default Codex reasoning effort");
    }
    return {
      id,
      model,
      displayName: item.displayName.trim(),
      description: item.description,
      defaultReasoningEffort,
      supportedReasoningEfforts: efforts,
      isDefault: item.isDefault,
    };
  });
}

export async function updateCodexPreferences(
  connection: AgentConnection,
  sessionId: string,
  model: string,
  effort: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  if (!CODEX_ID_PATTERN.test(sessionId)) throw new Error("Codex session is invalid");
  validateCodexPickerValue(model, "model selection");
  if (effort) validateCodexPickerValue(effort, "reasoning effort");
  const response = await agentFetch(connection, "api/codex/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, model, effort }),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex preference save failed: HTTP ${response.status}`);
}

export async function listCodexHistory(
  connection: AgentConnection,
  profile = "default",
  fetcher: Fetcher = fetch,
): Promise<CodexHistorySummary[]> {
  if (!CODEX_ID_PATTERN.test(profile)) throw new Error("Codex profile is invalid");
  const response = await agentFetch(connection, `api/codex/history?profile=${encodeURIComponent(profile)}`, {
    method: "GET",
  }, fetcher);
  if (!response.ok) throw new Error(`Codex history list failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 2 * 1024 * 1024);
  if (!Array.isArray(value) || value.length > 200) throw new Error("Agent returned an invalid Codex history list");
  return value.map(validateCodexHistorySummary);
}

export async function getCodexHistory(
  connection: AgentConnection,
  id: string,
  profile = "default",
  fetcher: Fetcher = fetch,
): Promise<CodexHistoryRecord> {
  validateCodexHistoryID(id);
  if (!CODEX_ID_PATTERN.test(profile)) throw new Error("Codex profile is invalid");
  const response = await agentFetch(connection, `api/codex/history/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, {
    method: "GET",
  }, fetcher);
  if (!response.ok) throw new Error(`Codex history read failed: HTTP ${response.status}`);
  return validateCodexHistoryRecord(await boundedJSON(response, 8 * 1024 * 1024));
}

export async function restoreCodexHistory(
  connection: AgentConnection,
  id: string,
  fetcher: Fetcher = fetch,
): Promise<{ session: CodexSession; history: CodexHistoryRecord }> {
  validateCodexHistoryID(id);
  const response = await agentFetch(connection, `api/codex/history/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }, fetcher);
  if (!response.ok) throw new Error(`Codex history restore failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 8 * 1024 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent returned an invalid Codex history restore response");
  }
  const result = value as { session?: unknown; history?: unknown };
  const session = result.session as Partial<CodexSession> | undefined;
  if (!session || typeof session.id !== "string" || typeof session.running !== "boolean") {
    throw new Error("Agent returned an invalid restored Codex session");
  }
  return { session: session as CodexSession, history: validateCodexHistoryRecord(result.history) };
}

export async function deleteCodexHistory(
  connection: AgentConnection,
  id: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  validateCodexHistoryID(id);
  const response = await agentFetch(connection, `api/codex/history/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }, fetcher);
  if (!response.ok && response.status !== 404) throw new Error(`Codex history delete failed: HTTP ${response.status}`);
}

export async function bulkDeleteCodexHistory(
  connection: AgentConnection,
  ids: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<number> {
  if (!ids.length || ids.length > 100) throw new Error("Select between 1 and 100 Codex histories");
  ids.forEach(validateCodexHistoryID);
  const response = await agentFetch(connection, "api/codex/history/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex history bulk delete failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 64 * 1024);
  const deleted = value && typeof value === "object" ? (value as { deleted?: unknown }).deleted : undefined;
  if (typeof deleted !== "number" || !Number.isSafeInteger(deleted) || deleted < 0 || deleted > ids.length) {
    throw new Error("Agent returned an invalid Codex history delete count");
  }
  return deleted;
}

export async function revealCodexFile(
  connection: AgentConnection,
  sessionId: string,
  path: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (!CODEX_ID_PATTERN.test(sessionId) || !path.trim() || path.length > 16_000) {
    throw new Error("Codex file path is invalid");
  }
  const response = await agentFetch(connection, "api/codex/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, path }),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex file reveal failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 64 * 1024);
  const revealedPath = value && typeof value === "object" ? (value as { path?: unknown }).path : undefined;
  if (typeof revealedPath !== "string" || !revealedPath) throw new Error("Agent returned an invalid revealed path");
  return revealedPath;
}

export async function sendCodexMessage(
  connection: AgentConnection,
  sessionId: string,
  text: string,
  fetcher: Fetcher = fetch,
  options: SendCodexMessageOptions = {},
): Promise<void> {
  const {
    attachmentIds = [],
    clientId = "",
    clientMessageId = "",
    permissionMode = "workspace-auto",
    model = "",
    effort = "",
  } = options;
  if (model) validateCodexPickerValue(model, "model selection");
  if (effort) validateCodexPickerValue(effort, "reasoning effort");
  const response = await agentFetch(connection, "api/codex/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      text,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      permissionMode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex message failed: HTTP ${response.status}`);
}

export async function interruptCodexTurn(
  connection: AgentConnection,
  sessionId: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await agentFetch(connection, "api/codex/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }, fetcher);
  if (!response.ok) throw new Error(`Codex interrupt failed: HTTP ${response.status}`);
}

export async function uploadCodexAttachments(
  connection: AgentConnection,
  sessionId: string,
  files: readonly File[],
  fetcher: Fetcher = fetch,
): Promise<CodexAttachment[]> {
  if (!files.length || files.length > 10) throw new Error("Select between 1 and 10 images");
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 30 * 1024 * 1024) throw new Error("Codex images exceed the 30MB limit");
  if (files.some((file) => !file.type.startsWith("image/"))) throw new Error("Codex attachments must be images");
  const body = new FormData();
  body.append("sessionId", sessionId);
  for (const file of files) body.append("files", file, file.name);
  const response = await agentFetch(connection, "api/codex/attachments", {
    method: "POST",
    body,
  }, fetcher);
  if (!response.ok) throw new Error(`Codex attachment upload failed: HTTP ${response.status}`);
  const value = await boundedJSON(response, 128 * 1024);
  const attachments = (value as { attachments?: unknown })?.attachments;
  if (!Array.isArray(attachments) || attachments.some((attachment) =>
    !attachment || typeof attachment !== "object" || typeof (attachment as CodexAttachment).id !== "string" ||
    typeof (attachment as CodexAttachment).name !== "string" || typeof (attachment as CodexAttachment).mimeType !== "string" ||
    typeof (attachment as CodexAttachment).bytes !== "number")) {
    throw new Error("Agent returned invalid Codex attachments");
  }
  return attachments as CodexAttachment[];
}

export async function deleteCodexAttachment(
  connection: AgentConnection,
  sessionId: string,
  attachmentId: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId)) {
    throw new Error("Codex attachment identity is invalid");
  }
  const response = await agentFetch(
    connection,
    `api/codex/attachments/${encodeURIComponent(attachmentId)}?sessionId=${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    fetcher,
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Codex attachment cleanup failed: HTTP ${response.status}`);
  }
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
  onError?: (error: Error, recoverable: boolean) => void,
  fetcher: Fetcher = fetch,
): { close: () => void } {
  const baseUrl = normalizeAgentBaseUrl(connection.baseUrl || DEFAULT_AGENT_BASE_URL);
  const controller = new AbortController();
  const headers = agentAuthHeaders(connection);
  let lastSequence = 0;
  const deliver = (event: CodexEvent): boolean => {
    const sequence = event.sequence;
    const previousSequence = lastSequence;
    if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0) {
      if (sequence > 0 && sequence <= lastSequence && event.method !== "openboard/session_state") return false;
      if (lastSequence > 0 && sequence > lastSequence + 1) {
        throw new Error(`Codex event stream sequence gap: expected ${lastSequence + 1}, received ${sequence}`);
      }
    }
    onEvent(event);
    if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0) {
      lastSequence = Math.max(lastSequence, sequence);
    }
    return typeof sequence !== "number" || sequence > previousSequence;
  };
  const wait = (milliseconds: number) => new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    controller.signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  void (async () => {
    let delay = 250;
    while (!controller.signal.aborted) {
      let reconnect = false;
      let madeProgress = false;
      const connectedAt = Date.now();
      try {
        const query = new URLSearchParams({ sessionId });
        if (lastSequence > 0) query.set("afterSequence", String(lastSequence));
        const response = await fetcher(`${baseUrl}/api/codex/events?${query}`, {
          headers,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (response.status === 404 || response.status === 410) {
          onError?.(new Error(`Codex event stream ended: HTTP ${response.status}`), false);
          return;
        }
        if (response.status === 409) {
          onError?.(new Error("Codex event history expired; start a new session to avoid an incomplete transcript"), false);
          return;
        }
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
          for (const event of parsed.events) madeProgress = deliver(event) || madeProgress;
        }
        const parsed = parseCodexSseRecords(buffer, true);
        for (const event of parsed.events) madeProgress = deliver(event) || madeProgress;
        reconnect = true;
        if (!madeProgress) {
          onError?.(new Error("Codex event stream ended unexpectedly"), true);
        }
        if (madeProgress || Date.now() - connectedAt >= 1_000) delay = 250;
      } catch (error) {
        if (controller.signal.aborted) return;
        reconnect = true;
        onError?.(error instanceof Error ? error : new Error("codex stream error"), true);
      }
      if (!reconnect || controller.signal.aborted) return;
      await wait(delay);
      delay = Math.min(5_000, delay * 2);
    }
  })();
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


export type ClaudeSession = {
  id: string;
  claudeSessionId?: string;
  profile?: string;
  reused?: boolean;
  running?: boolean;
  runtimeClientId?: string;
  available?: boolean;
};

export type ClaudeEvent = {
  sequence?: number;
  type: "notification" | "error" | "status";
  method?: string;
  params?: unknown;
  data?: unknown;
};

export async function createClaudeSession(
  connection: AgentConnection,
  options: { profile?: string; fresh?: boolean; cwd?: string } = {},
  fetcher: Fetcher = fetch,
): Promise<ClaudeSession> {
  const response = await agentFetch(connection, "api/claude/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: options.profile ?? "claude-default",
      fresh: options.fresh ?? false,
      cwd: options.cwd,
    }),
  }, fetcher);
  if (!response.ok) throw new Error(await response.text() || `Claude session failed: HTTP ${response.status}`);
  return response.json() as Promise<ClaudeSession>;
}

export async function getClaudeSession(
  connection: AgentConnection,
  profile = "claude-default",
  fetcher: Fetcher = fetch,
): Promise<ClaudeSession | null> {
  const response = await agentFetch(
    connection,
    `api/claude/session?profile=${encodeURIComponent(profile)}`,
    { method: "GET" },
    fetcher,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await response.text() || `Claude session lookup failed: HTTP ${response.status}`);
  return response.json() as Promise<ClaudeSession>;
}

export async function sendClaudeMessage(
  connection: AgentConnection,
  sessionId: string,
  prompt: string,
  fetcher: Fetcher = fetch,
  runtimeClientId?: string,
): Promise<void> {
  const response = await agentFetch(connection, "api/claude/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompt, runtimeClientId }),
  }, fetcher);
  if (!response.ok) throw new Error(await response.text() || `Claude message failed: HTTP ${response.status}`);
}

export async function interruptClaudeTurn(
  connection: AgentConnection,
  sessionId: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await agentFetch(connection, "api/claude/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }, fetcher);
  if (!response.ok) throw new Error(await response.text() || `Claude interrupt failed: HTTP ${response.status}`);
}

export async function closeClaudeSession(
  connection: AgentConnection,
  sessionId: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await agentFetch(connection, `api/claude/session/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  }, fetcher);
  if (!response.ok && response.status !== 404) {
    throw new Error(await response.text() || `Claude close failed: HTTP ${response.status}`);
  }
}

export function subscribeClaudeEvents(
  connection: AgentConnection,
  sessionId: string,
  handlers: {
    onEvent: (event: ClaudeEvent) => void;
    onError?: (error: Error, willRetry: boolean) => void;
  },
  fetcher: Fetcher = fetch,
): () => void {
  let stopped = false;
  let afterSequence = 0;
  let controller: AbortController | null = null;
  let timer: number | undefined;
  const { onEvent, onError } = handlers;

  const pump = async () => {
    if (stopped) return;
    controller = new AbortController();
    const baseUrl = connection.baseUrl.replace(/\/$/, "");
    const query = new URLSearchParams({ sessionId });
    if (afterSequence > 0) query.set("afterSequence", String(afterSequence));
    try {
      const headers = agentAuthHeaders(connection);
      const response = await fetcher(`${baseUrl}/api/claude/events?${query}`, {
        headers,
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Claude events failed: HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseCodexSseRecords(buffer);
        buffer = remainder;
        for (const raw of events) {
          const event = raw as unknown as ClaudeEvent;
          if (typeof event.sequence === "number" && event.sequence > afterSequence) {
            afterSequence = event.sequence;
          }
          onEvent(event);
        }
      }
      if (!stopped) {
        onError?.(new Error("claude stream closed"), true);
        timer = window.setTimeout(() => void pump(), 800);
      }
    } catch (error) {
      if (stopped) return;
      onError?.(error instanceof Error ? error : new Error("claude stream error"), true);
      timer = window.setTimeout(() => void pump(), 1200);
    }
  };

  void pump();
  return () => {
    stopped = true;
    controller?.abort();
    if (timer) window.clearTimeout(timer);
  };
}
