import { describe, expect, test } from "bun:test";

import {
  normalizeCodexHistorySelection,
  sortCodexHistory,
  toggleCodexHistorySelection,
  type CodexHistorySummary,
} from "./codex-history";

const record = (id: string, updatedAt: string): CodexHistorySummary => ({
  id,
  profile: "default",
  title: id,
  threadId: `thread-${id}`,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt,
  messageCount: 1,
  preview: `${id} preview`,
  status: "completed",
});

describe("Codex history manager helpers", () => {
  test("sorts newest records without mutating the server response", () => {
    const input = [record("old", "2026-07-30T00:00:00.000Z"), record("new", "2026-07-31T00:00:00.000Z")];
    expect(sortCodexHistory(input).map((item) => item.id)).toEqual(["new", "old"]);
    expect(input.map((item) => item.id)).toEqual(["old", "new"]);
  });

  test("drops unknown and duplicate selections before bulk deletion", () => {
    expect(normalizeCodexHistorySelection(
      [record("a", "2026-07-31T00:00:00.000Z"), record("b", "2026-07-30T00:00:00.000Z")],
      ["b", "unknown", "b", "a"],
    )).toEqual(["a", "b"]);
  });

  test("toggles one record immutably", () => {
    const current = ["a"];
    expect(toggleCodexHistorySelection(current, "b", true)).toEqual(["a", "b"]);
    expect(toggleCodexHistorySelection(current, "a", false)).toEqual([]);
    expect(current).toEqual(["a"]);
  });
});
