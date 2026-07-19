import type { CodexEvent } from "./local-agent";

export type CodexEventEffect =
  | { kind: "assistant-delta"; text: string }
  | { kind: "item"; text: string; itemType: string; command?: string; path?: string; status?: string; detail?: string }
  | { kind: "turn"; status: "running" | "completed" | "failed"; error?: string }
  | { kind: "approval"; event: CodexEvent }
  | { kind: "ignore" };

export function codexApprovalKey(event: CodexEvent): string {
  if (event.id !== undefined && event.id !== null) return `id:${String(event.id)}`;
  return `request:${event.method ?? ""}:${JSON.stringify(event.params ?? null)}`;
}

export function codexApprovalResolutionKey(event: CodexEvent): string | undefined {
  if (event.method !== "openboard/approval_resolved" || event.id === undefined || event.id === null) {
    return undefined;
  }
  return `id:${String(event.id)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function codexEventThreadId(event: CodexEvent): string | undefined {
  const params = record(event.params);
  const turn = record(params?.turn);
  const thread = record(params?.thread);
  for (const value of [params?.threadId, turn?.threadId, thread?.id]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  const object = record(value);
  if (!object) return undefined;
  for (const key of ["message", "error", "detail", "reason"]) {
    const text = errorText(object[key]);
    if (text) return text;
  }
  return undefined;
}

export function classifyCodexEvent(event: CodexEvent): CodexEventEffect {
  if (event.type === "approval") return { kind: "approval", event };
  const params = record(event.params);
  const eventError = errorText(event.data) ?? errorText(params?.error) ?? errorText(params?.message);
  if (event.type === "error" || event.method === "error" || eventError && event.method?.includes("error")) {
    return { kind: "turn", status: "failed", ...(eventError ? { error: eventError } : {}) };
  }
  const delta = typeof params?.delta === "string" ? params.delta : typeof params?.text === "string" ? params.text : "";
  if (delta && (event.method?.includes("agent_message") || event.method?.includes("message"))) {
    return { kind: "assistant-delta", text: delta };
  }
  const method = event.method ?? "";
  if (method === "turn/started" || method === "turn_started") return { kind: "turn", status: "running" };
  if (method === "turn/completed" || method === "turn_completed") return { kind: "turn", status: "completed" };
  if (method === "turn/failed" || method === "turn_failed") {
    return { kind: "turn", status: "failed", ...(eventError ? { error: eventError } : {}) };
  }
  if (method.includes("item/")) {
    const item = record(params?.item) ?? params;
    const kind = typeof item?.type === "string" ? item.type : method;
    const command = typeof item?.command === "string" ? item.command : undefined;
    const path = typeof item?.path === "string" ? item.path : undefined;
    const detail = command ?? path ?? (typeof item?.text === "string" ? item.text : "");
    const status = typeof item?.status === "string" ? item.status : undefined;
    const extra = typeof item?.description === "string" ? item.description
      : typeof item?.reason === "string" ? item.reason : undefined;
    return { kind: "item", itemType: kind, command, path, status, detail: extra, text: detail ? `${kind}: ${detail}` : kind };
  }
  return { kind: "ignore" };
}
