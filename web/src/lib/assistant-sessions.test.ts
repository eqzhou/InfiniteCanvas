import { describe, expect, test } from "bun:test";

import { deleteAssistantSessions } from "./assistant-sessions";
import type { AssistantSession } from "@/types/board";

const session = (id: string): AssistantSession => ({
  id,
  title: id,
  messages: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("deleteAssistantSessions", () => {
  test("keeps the active session when it was not deleted", () => {
    const result = deleteAssistantSessions(
      [session("a"), session("b"), session("c")],
      "b",
      new Set(["a", "c"]),
      () => session("new"),
    );
    expect(result.sessions.map((item) => item.id)).toEqual(["b"]);
    expect(result.activeId).toBe("b");
  });

  test("selects the first remaining session when active is deleted", () => {
    const result = deleteAssistantSessions(
      [session("a"), session("b"), session("c")],
      "b",
      new Set(["b"]),
      () => session("new"),
    );
    expect(result.sessions.map((item) => item.id)).toEqual(["a", "c"]);
    expect(result.activeId).toBe("a");
  });

  test("creates one empty fallback after deleting every session", () => {
    const result = deleteAssistantSessions(
      [session("a"), session("b")],
      "a",
      new Set(["a", "b"]),
      () => session("new"),
    );
    expect(result.sessions.map((item) => item.id)).toEqual(["new"]);
    expect(result.activeId).toBe("new");
  });
});
