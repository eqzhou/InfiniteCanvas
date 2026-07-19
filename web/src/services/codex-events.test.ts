import { describe, expect, test } from "bun:test";
import {
  classifyCodexEvent,
  codexApprovalKey,
  codexApprovalResolutionKey,
  codexEventThreadId,
} from "./codex-events";

describe("Codex event classification", () => {
  test("coalesces assistant deltas", () => {
    expect(classifyCodexEvent({ type: "notification", method: "agent_message_delta", params: { delta: "hi" } })).toEqual({ kind: "assistant-delta", text: "hi" });
  });
  test("recognizes turn lifecycle and failures", () => {
    expect(classifyCodexEvent({ type: "notification", method: "turn/completed" })).toEqual({ kind: "turn", status: "completed" });
    expect(classifyCodexEvent({ type: "notification", method: "turn/failed", params: { error: "x" } })).toEqual({ kind: "turn", status: "failed", error: "x" });
    expect(classifyCodexEvent({ type: "notification", method: "turn/failed", params: { error: { message: "nested failure" } } })).toEqual({ kind: "turn", status: "failed", error: "nested failure" });
    expect(classifyCodexEvent({ type: "error", data: { message: "transport failure" } })).toEqual({ kind: "turn", status: "failed", error: "transport failure" });
    expect(classifyCodexEvent({ type: "notification", method: "error", params: { message: "request failure" } })).toEqual({ kind: "turn", status: "failed", error: "request failure" });
  });
  test("does not treat item or tool completion as turn completion", () => {
    expect(classifyCodexEvent({ type: "notification", method: "item/turn/completed", params: { item: { type: "tool" } } }).kind).toBe("item");
    expect(classifyCodexEvent({ type: "notification", method: "tool/turn_completed", params: { status: "completed" } }).kind).not.toBe("turn");
  });
  test("extracts thread ownership from supported event envelopes", () => {
    expect(codexEventThreadId({ type: "notification", params: { threadId: "thread-one" } })).toBe("thread-one");
    expect(codexEventThreadId({ type: "notification", params: { turn: { threadId: "thread-two" } } })).toBe("thread-two");
  });
  test("summarizes command and file items", () => {
    expect(classifyCodexEvent({ type: "notification", method: "item/commandExecution", params: { item: { type: "command", command: "go test ./...", status: "completed", description: "verification" } } })).toEqual({ kind: "item", itemType: "command", command: "go test ./...", path: undefined, status: "completed", detail: "verification", text: "command: go test ./..." });
    expect(classifyCodexEvent({ type: "notification", method: "item/fileChange", params: { path: "web/src/App.tsx" } })).toEqual({ kind: "item", itemType: "item/fileChange", command: undefined, path: "web/src/App.tsx", status: undefined, detail: undefined, text: "item/fileChange: web/src/App.tsx" });
  });
  test("preserves approval events", () => {
    const event = { type: "approval" as const, method: "item/tool/call", id: 1 };
    expect(classifyCodexEvent(event)).toEqual({ kind: "approval", event });
    expect(codexApprovalKey(event)).toBe("id:1");
    expect(codexApprovalKey({ type: "approval", method: "tool/call", params: { tool: "board.add_node" } })).toBe('request:tool/call:{"tool":"board.add_node"}');
    expect(codexApprovalResolutionKey({ type: "notification", method: "openboard/approval_resolved", id: 1 })).toBe("id:1");
    expect(codexApprovalResolutionKey({ type: "notification", method: "item/completed", id: 1 })).toBeUndefined();
  });
});
