import { describe, expect, test } from "bun:test";
import { resolveConfigPrompt } from "./config-generation";

describe("resolveConfigPrompt", () => {
  test("uses ordered upstream text only when the config follows upstream", () => {
    expect(resolveConfigPrompt({
      promptSource: "upstream",
      prompt: "local draft must not leak in",
      upstreamTexts: ["first", "second"],
    })).toBe("first\n\nsecond");
  });

  test("keeps an independent config prompt independent from connected text", () => {
    expect(resolveConfigPrompt({
      promptSource: "independent",
      prompt: "local draft",
      upstreamTexts: ["upstream text"],
    })).toBe("local draft");
  });

  test("uses a legacy config's local prompt when it has no upstream text", () => {
    expect(resolveConfigPrompt({
      prompt: "legacy prompt",
      upstreamTexts: [],
    })).toBe("legacy prompt");
  });
});
