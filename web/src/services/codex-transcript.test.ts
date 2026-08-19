import { describe, expect, test } from "bun:test";

import {
  addCodexUserMessage,
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

  test("bounds persisted messages and event ownership keys", () => {
    const cyclic: Record<string, unknown> = { type: "notification" };
    cyclic.data = cyclic;
    const messages = [
      null as unknown as { role: "user"; text: string },
      { role: "system", text: "ignore" } as unknown as { role: "user"; text: string },
      { role: "user", text: "" },
      { id: "x".repeat(129), role: "user" as const, text: "long id is dropped" },
      { id: "keep", role: "assistant" as const, text: "x".repeat(100_010) },
      ...Array.from({ length: 125 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 ? "assistant" as const : "user" as const,
        text: `message ${index}`,
      })),
    ];
    const state = hydrateCodexTranscript(messages, [cyclic as unknown as CodexTranscriptEvent,
      ...Array.from({ length: 4_100 }, (_, sequence) => event({ sequence }))]);
    expect(state.messages).toHaveLength(120);
    expect(state.messages[0]?.id).toBe("message-5");
    expect(state.messages.at(-1)?.id).toBe("message-124");
    expect(state.seenEventKeys).toHaveLength(4_096);
    expect(state.seenEventKeys[0]).toBe("sequence:4");
    expect(state.seenEventKeys.at(-1)).toBe("sequence:4099");
  });

  test("rejects malformed event shapes without changing state", () => {
    const initial = hydrateCodexTranscript([], []);
    const malformed = [
      { type: "" },
      { type: "notification", method: "m".repeat(129) },
      { type: "notification", sequence: -1 },
      { type: "notification", sequence: Number.MAX_SAFE_INTEGER + 1 },
      [] as unknown as CodexTranscriptEvent,
      cyclicEvent(),
    ];
    for (const candidate of malformed) {
      const next = applyCodexTranscriptEvent(initial, candidate as CodexTranscriptEvent);
      expect(next).toBe(initial);
    }
  });

  test("handles all supported user and assistant payload forms", () => {
    let state = hydrateCodexTranscript([], []);
    state = addCodexUserMessage(state, { id: "user-one", text: "draft" });
    state = applyCodexTranscriptEvent(state, event({
      sequence: 2,
      method: "openboard/user_message",
      data: { id: "user-one", text: "server copy" },
    }));
    expect(state.messages).toEqual([{ id: "user-one", role: "user", text: "server copy" }]);

    state = applyCodexTranscriptEvent(state, event({
      sequence: 3,
      method: "agent/message/delta",
      params: { text: "one", item: { id: "assistant-one" } },
    }));
    state = applyCodexTranscriptEvent(state, event({
      sequence: 4,
      method: "message/stream",
      params: { delta: " two", itemId: "assistant-one" },
    }));
    state = applyCodexTranscriptEvent(state, event({
      sequence: 5,
      method: "agent_message_delta",
      params: { delta: " three", message: { id: "assistant-one" } },
    }));
    expect(state.messages.at(-1)).toEqual({ id: "assistant-one", role: "assistant", text: "one two three" });

    // A delta without an id appends to the current assistant turn; a new id
    // starts a separate turn even when its payload is otherwise equivalent.
    state = applyCodexTranscriptEvent(state, event({ sequence: 6, method: "agent_message_delta", params: { delta: " four" } }));
    state = applyCodexTranscriptEvent(state, event({ sequence: 7, method: "agent_message_delta", params: { delta: "fresh", messageId: "assistant-two" } }));
    expect(state.messages.at(-2)).toEqual({ id: "assistant-one", role: "assistant", text: "one two three four" });
    expect(state.messages.at(-1)).toEqual({ id: "assistant-two", role: "assistant", text: "fresh" });

    const beforeIgnored = state;
    const ignored = applyCodexTranscriptEvent(state, event({ sequence: 8, method: "turn/completed", params: {} }));
    expect(ignored.messages).toBe(beforeIgnored.messages);
    expect(ignored.seenEventKeys).toContain("sequence:8");
  });

  test("merges ids, exact messages, and partial assistant output immutably", () => {
    const history = [
      { id: "u1", role: "user" as const, text: "same" },
      { id: "a1", role: "assistant" as const, text: "long history" },
      { role: "assistant" as const, text: "exact" },
    ];
    const live = [
      { id: "u1", role: "user" as const, text: "same" },
      { id: "a1", role: "assistant" as const, text: "short" },
      { role: "assistant" as const, text: "exact" },
      { role: "assistant" as const, text: "brand new" },
    ];
    const merged = mergeCodexTranscript({ messages: live, seenEventKeys: ["live"] }, history, [event({ sequence: 20 })]);
    expect(merged.messages).toEqual([
      { id: "u1", role: "user", text: "same" },
      { id: "a1", role: "assistant", text: "long history" },
      { role: "assistant", text: "exact" },
      { role: "assistant", text: "brand new" },
    ]);
    expect(merged.seenEventKeys).toEqual(["sequence:20", "live"]);
    expect(history).toEqual([
      { id: "u1", role: "user", text: "same" },
      { id: "a1", role: "assistant", text: "long history" },
      { role: "assistant", text: "exact" },
    ]);
  });
});

function cyclicEvent(): CodexTranscriptEvent {
  const eventValue: CodexTranscriptEvent & { data?: unknown } = { type: "notification" };
  eventValue.data = eventValue;
  return eventValue;
}
