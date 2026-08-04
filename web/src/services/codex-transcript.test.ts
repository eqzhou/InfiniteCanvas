import { describe, expect, test } from "bun:test";

import {
  applyCodexTranscriptEvent,
  hydrateCodexTranscript,
  mergeCodexTranscript,
  type CodexTranscriptEvent,
} from "./codex-transcript";

function event(overrides: Partial<CodexTranscriptEvent>): CodexTranscriptEvent {
  return {
    sequence: 1,
    type: "notification",
    ...overrides,
  };
}

describe("Codex transcript ownership", () => {
  test("hydrates history event ownership so replayed live events do not duplicate messages", () => {
    const historyEvent = event({
      method: "openboard/user_message",
      data: { id: "message-one", text: "检查画布" },
    });
    let state = hydrateCodexTranscript([
      { id: "message-one", role: "user", text: "检查画布" },
      { id: "assistant-one", role: "assistant", text: "已完成" },
    ], [historyEvent]);

    state = applyCodexTranscriptEvent(state, historyEvent);

    expect(state.messages).toEqual([
      { id: "message-one", role: "user", text: "检查画布" },
      { id: "assistant-one", role: "assistant", text: "已完成" },
    ]);
  });

  test("upserts optimistic and server-owned user messages by stable id", () => {
    let state = hydrateCodexTranscript([], []);
    state = applyCodexTranscriptEvent(state, event({
      method: "openboard/user_message",
      data: { id: "message-two", text: "先显示" },
    }));
    state = applyCodexTranscriptEvent(state, event({
      sequence: 2,
      method: "openboard/user_message",
      data: { id: "message-two", text: "先显示" },
    }));

    expect(state.messages).toEqual([{ id: "message-two", role: "user", text: "先显示" }]);
  });

  test("deduplicates repeated assistant replay while preserving distinct deltas", () => {
    let state = hydrateCodexTranscript([], []);
    state = applyCodexTranscriptEvent(state, event({
      sequence: 3,
      method: "agent_message_delta",
      params: { delta: "第一段" },
    }));
    state = applyCodexTranscriptEvent(state, event({
      sequence: 3,
      method: "agent_message_delta",
      params: { delta: "第一段" },
    }));
    state = applyCodexTranscriptEvent(state, event({
      sequence: 4,
      method: "agent_message_delta",
      params: { delta: "第二段" },
    }));

    expect(state.messages).toEqual([{ role: "assistant", text: "第一段第二段" }]);
  });

  test("merges delayed history hydration without discarding newer live output", () => {
    let live = hydrateCodexTranscript([], []);
    live = applyCodexTranscriptEvent(live, event({
      sequence: 8,
      method: "agent_message_delta",
      params: { delta: "完整的实时回复" },
    }));

    const merged = mergeCodexTranscript(live, [
      { id: "history-assistant", role: "assistant", text: "完整的", createdAt: "2026-08-04T00:00:00Z" },
    ], []);

    expect(merged.messages).toEqual([{ id: "history-assistant", role: "assistant", text: "完整的实时回复" }]);
  });

  test("preserves legitimate repeated messages that have no stable ids", () => {
    const state = hydrateCodexTranscript([], []);
    const merged = mergeCodexTranscript({
      ...state,
      messages: [
        { role: "assistant", text: "好的" },
        { role: "assistant", text: "好的" },
      ],
    }, [{ role: "assistant", text: "好的" }], []);

    expect(merged.messages).toEqual([
      { role: "assistant", text: "好的" },
      { role: "assistant", text: "好的" },
    ]);
  });

  test("ignores malformed events and bounds a live assistant message", () => {
    let state = hydrateCodexTranscript([], [null as unknown as CodexTranscriptEvent]);
    expect(state.seenEventKeys).toEqual([]);
    state = applyCodexTranscriptEvent(state, {
      type: "notification",
      method: "agent_message_delta",
      params: { delta: "x".repeat(120_000) },
    });
    expect(state.messages).toEqual([]);
    state = applyCodexTranscriptEvent(state, {
      sequence: 1,
      type: "notification",
      method: "agent_message_delta",
      params: { delta: "x".repeat(60_000) },
    });
    state = applyCodexTranscriptEvent(state, {
      sequence: 2,
      type: "notification",
      method: "agent_message_delta",
      params: { delta: "y".repeat(60_000) },
    });
    expect(state.messages[0]?.text).toHaveLength(100_000);
  });
});
