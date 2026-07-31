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

  test("exposes retained past and future snapshots without exposing internal arrays", () => {
    const history = new HistoryStack<{ id: number }>();
    history.push({ id: 1 });
    history.push({ id: 2 });
    expect(history.undo({ id: 3 })).toEqual({ id: 2 });

    const snapshots = history.snapshots();
    expect(snapshots.map((item) => item.id)).toEqual([1, 3]);
    expect(history.snapshots()).not.toBe(snapshots);
  });

  test("clears both branches and exposes undo availability", () => {
    const history = new HistoryStack<number>();
    expect(history.canUndo).toBe(false);
    history.push(1);
    expect(history.canUndo).toBe(true);
    expect(history.undo(2)).toBe(1);
    expect(history.canRedo).toBe(true);
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.snapshots()).toEqual([]);
  });
});
