import { describe, expect, test } from "bun:test";

import { isSubmitShortcut } from "./keyboard";

describe("isSubmitShortcut", () => {
  test("accepts Ctrl/Cmd+Enter outside IME composition", () => {
    expect(isSubmitShortcut({ key: "Enter", ctrlKey: true, metaKey: false, isComposing: false })).toBe(true);
    expect(isSubmitShortcut({ key: "Enter", ctrlKey: false, metaKey: true, isComposing: false })).toBe(true);
  });

  test("rejects shortcuts while IME composition is active", () => {
    expect(isSubmitShortcut({ key: "Enter", ctrlKey: true, metaKey: false, isComposing: true })).toBe(false);
    expect(isSubmitShortcut({ key: "Enter", ctrlKey: false, metaKey: true, isComposing: true })).toBe(false);
  });

  test("rejects unrelated key combinations", () => {
    expect(isSubmitShortcut({ key: "Enter", ctrlKey: false, metaKey: false, isComposing: false })).toBe(false);
    expect(isSubmitShortcut({ key: "a", ctrlKey: true, metaKey: false, isComposing: false })).toBe(false);
  });
});
