import { describe, expect, test } from "bun:test";

import { applyAgentComposerSuggestion, detectAgentComposerTrigger } from "./agent-composer";

describe("Agent composer structured suggestions", () => {
  test("detects slash skills and at-sign canvas references at the cursor", () => {
    expect(detectAgentComposerTrigger("请 /rev", 6)).toEqual({ kind: "skill", query: "rev", start: 2, end: 6 });
    expect(detectAgentComposerTrigger("比较 @主图", 6)).toEqual({ kind: "node", query: "主图", start: 3, end: 6 });
    expect(detectAgentComposerTrigger("https://example.com", 8)).toBeNull();
  });

  test("inserts a readable token and deduplicates immutable metadata", () => {
    const reference = { kind: "node" as const, id: "node-1", label: "产品主图" };
    const first = applyAgentComposerSuggestion("比较 @主", { kind: "node", query: "主", start: 3, end: 5 }, reference, []);
    const second = applyAgentComposerSuggestion(first.text, detectAgentComposerTrigger(`${first.text}@产`, first.text.length + 2)!, reference, first.references);
    expect(first).toEqual({ text: "比较 @产品主图 ", cursor: 9, references: [reference] });
    expect(second.references).toEqual([reference]);
  });
});
