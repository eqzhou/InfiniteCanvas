import { describe, expect, test } from "bun:test";
import { classifyCodexEvent, codexApprovalKey } from "./codex-events";

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
  test("summarizes command and file items", () => {
    expect(classifyCodexEvent({ type: "notification", method: "item/commandExecution", params: { item: { type: "command", command: "go test ./...", status: "completed", description: "verification" } } })).toEqual({ kind: "item", itemType: "command", command: "go test ./...", path: undefined, status: "completed", detail: "verification", text: "command: go test ./..." });
    expect(classifyCodexEvent({ type: "notification", method: "item/fileChange", params: { path: "web/src/App.tsx" } })).toEqual({ kind: "item", itemType: "item/fileChange", command: undefined, path: "web/src/App.tsx", status: undefined, detail: undefined, text: "item/fileChange: web/src/App.tsx" });
  });
  test("preserves approval events", () => {
    const event = { type: "approval" as const, method: "item/tool/call", id: 1 };
    expect(classifyCodexEvent(event)).toEqual({ kind: "approval", event });
    expect(codexApprovalKey(event)).toBe("id:1");
    expect(codexApprovalKey({ type: "approval", method: "tool/call", params: { tool: "board.add_node" } })).toBe('request:tool/call:{"tool":"board.add_node"}');
  });
});
