import { describe, expect, test } from "bun:test";
import {
  expandPromptTextWithBreaks,
  normalizePromptClipboardText,
  serializePromptEditorChildren,
} from "./prompt-chip-editor";

describe("prompt chip editor serialization", () => {
  test("normalizes Windows clipboard newlines", () => {
    expect(normalizePromptClipboardText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  test("expands pasted text into text and break nodes, including blank lines", () => {
    expect(expandPromptTextWithBreaks("line1\n\nline3")).toEqual([
      { type: "text", value: "line1" },
      { type: "break" },
      { type: "text", value: "" },
      { type: "break" },
      { type: "text", value: "line3" },
    ]);
  });

  test("serializes block-based Enter structure without collapsing blank lines", () => {
    expect(serializePromptEditorChildren([
      { type: "block", children: [{ type: "text", value: "alpha" }] },
      { type: "block", children: [{ type: "text", value: "" }] },
      { type: "block", children: [{ type: "text", value: "beta" }] },
    ], { root: true })).toBe("alpha\n\nbeta");
  });

  test("serializes mixed inline references and hard breaks", () => {
    expect(serializePromptEditorChildren([
      { type: "text", value: "use " },
      { type: "reference", label: "图片1" },
      { type: "break" },
      { type: "text", value: "then " },
      { type: "reference", label: "图片2" },
    ], { root: true })).toBe("use 图片1\nthen 图片2");
  });
});
