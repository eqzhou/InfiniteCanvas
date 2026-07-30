import { describe, expect, test } from "bun:test";
import { resolveConfigPrompt } from "./config-generation";

describe("resolveConfigPrompt", () => {
  test("uses ordered upstream text when the config prompt is blank", () => {
    expect(resolveConfigPrompt({
      prompt: "",
      upstreamTexts: ["first", "second"],
    })).toBe("first\n\nsecond");
  });

  test("keeps an authored config prompt independent from upstream text", () => {
    expect(resolveConfigPrompt({
      prompt: "local draft",
      upstreamTexts: ["upstream text"],
    })).toBe("local draft");
  });

  test("uses the config prompt when there is no upstream text", () => {
    expect(resolveConfigPrompt({
      prompt: "legacy prompt",
      upstreamTexts: [],
    })).toBe("legacy prompt");
  });
});
