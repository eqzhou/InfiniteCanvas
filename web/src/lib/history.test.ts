import { describe, expect, test } from "bun:test";

import { HistoryStack } from "./history";

describe("HistoryStack", () => {
  test("undo and redo preserve chronological state", () => {
    const history = new HistoryStack<number>();
    history.push(1);
    history.push(2);

    expect(history.undo(3)).toBe(2);
    expect(history.undo(2)).toBe(1);
    expect(history.redo(1)).toBe(2);
    expect(history.redo(2)).toBe(3);
  });

  test("a new edit clears the redo branch", () => {
    const history = new HistoryStack<number>();
    history.push(1);
    expect(history.undo(2)).toBe(1);

    history.push(7);
    expect(history.canRedo).toBe(false);
  });

  test("history respects its configured limit", () => {
    const history = new HistoryStack<number>(2);
    history.push(1);
    history.push(2);
    history.push(3);

    expect(history.undo(4)).toBe(3);
    expect(history.undo(3)).toBe(2);
    expect(history.undo(2)).toBeNull();
  });
});
