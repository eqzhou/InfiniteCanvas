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
    expect(classifyCodexEvent({
      type: "notification",
      method: "item/completed",
      params: {
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "go test ./...",
          status: "completed",
          description: "verification",
        },
      },
    })).toEqual({
      kind: "item",
      itemId: "command-1",
      itemType: "commandExecution",
      label: "运行命令",
      command: "go test ./...",
      path: undefined,
      status: "completed",
      detail: "verification",
      error: undefined,
      text: "commandExecution: go test ./...",
    });
    expect(classifyCodexEvent({
      type: "notification",
      method: "item/started",
      params: { item: { id: "file-1", type: "fileChange", path: "web/src/App.tsx" } },
    })).toEqual({
      kind: "item",
      itemId: "file-1",
      itemType: "fileChange",
      label: "修改文件",
      command: undefined,
      path: "web/src/App.tsx",
      status: "running",
      detail: undefined,
      error: undefined,
      text: "fileChange: web/src/App.tsx",
    });
  });
  test("preserves approval events", () => {
    const event = { type: "approval" as const, method: "item/tool/call", id: 1 };
    expect(classifyCodexEvent(event)).toEqual({ kind: "approval", event });
    expect(codexApprovalKey(event)).toBe("id:1");
    expect(codexApprovalKey({ type: "approval", method: "tool/call", params: { tool: "board.add_node" } })).toBe('request:tool/call:{"tool":"board.add_node"}');
    expect(codexApprovalResolutionKey({ type: "notification", method: "openboard/approval_resolved", id: 1 })).toBe("id:1");
    expect(codexApprovalResolutionKey({ type: "notification", method: "item/completed", id: 1 })).toBeUndefined();
  });

  test("keeps incremental reasoning summaries in the process timeline", () => {
    expect(classifyCodexEvent({
      type: "notification",
      method: "item/reasoning/summaryTextDelta",
      params: { itemId: "reasoning-1", delta: "检查画布状态" },
    })).toMatchObject({
      kind: "item",
      itemId: "reasoning-1",
      label: "思考",
      status: "running",
      detail: "检查画布状态",
      appendDetail: true,
    });
  });
});
