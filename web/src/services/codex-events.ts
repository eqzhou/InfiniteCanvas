import type { CodexEvent } from "./local-agent";

export type CodexEventEffect =
  | { kind: "assistant-delta"; text: string }
  | {
      kind: "item";
      text: string;
      itemId?: string;
      itemType: string;
      label: string;
      command?: string;
      path?: string;
      status: "running" | "completed" | "failed";
      detail?: string;
      appendDetail?: boolean;
      error?: string;
    }
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

function itemLabel(itemType: string): string {
  const value = itemType.toLowerCase();
  if (value.includes("command")) return "运行命令";
  if (value.includes("filechange") || value.includes("file_change")) return "修改文件";
  if (value.includes("mcptool") || value.includes("toolcall") || value.includes("tool_call")) return "调用工具";
  if (value.includes("reasoning")) return "思考";
  if (value.includes("plan")) return "更新计划";
  if (value.includes("websearch") || value.includes("web_search")) return "搜索网页";
  return "处理步骤";
}

function itemStatus(method: string, rawStatus: unknown, error?: string): "running" | "completed" | "failed" {
  const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : "";
  if (error || status.includes("fail") || status.includes("error")) return "failed";
  if (method.endsWith("/completed") || status.includes("complete") || status === "success") return "completed";
  return "running";
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
    const itemId = typeof item?.id === "string" ? item.id
      : typeof params?.itemId === "string" ? params.itemId
        : undefined;
    const command = typeof item?.command === "string" ? item.command : undefined;
    const path = typeof item?.path === "string" ? item.path : undefined;
    const streamDelta = typeof params?.delta === "string" ? params.delta : undefined;
    const detail = command ?? path ?? (typeof item?.text === "string" ? item.text : streamDelta ?? "");
    const extra = typeof item?.description === "string" ? item.description
      : typeof item?.reason === "string" ? item.reason : undefined;
    const itemError = errorText(item?.error) ?? errorText(item?.failure) ?? (method.includes("failed") ? extra : undefined);
    return {
      kind: "item",
      itemId,
      itemType: kind,
      label: itemLabel(kind),
      command,
      path,
      status: itemStatus(method, item?.status, itemError),
      detail: extra ?? streamDelta,
      ...(streamDelta ? { appendDetail: true } : {}),
      error: itemError,
      text: detail ? `${kind}: ${detail}` : kind,
    };
  }
  return { kind: "ignore" };
}
