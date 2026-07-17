import { describe, expect, test } from "bun:test";
import { applySystemPrompt, normalizeAppConfig, SYSTEM_PROMPT_MAX_LENGTH } from "@/lib/app-config";
import { createDefaultConfig } from "@/lib/defaults";

describe("application configuration", () => {
  test("normalizes missing and oversized system prompts without mutating input", () => {
    const missing = { ...createDefaultConfig(), systemPrompt: undefined };
    const oversized = { ...createDefaultConfig(), systemPrompt: "x".repeat(SYSTEM_PROMPT_MAX_LENGTH + 5) };

    expect(normalizeAppConfig(missing as unknown as ReturnType<typeof createDefaultConfig>).systemPrompt)
      .toBe("");
    expect(normalizeAppConfig(oversized).systemPrompt).toHaveLength(SYSTEM_PROMPT_MAX_LENGTH);
    expect(oversized.systemPrompt).toHaveLength(SYSTEM_PROMPT_MAX_LENGTH + 5);
  });

  test("composes a system instruction before the user prompt", () => {
    expect(applySystemPrompt("  Keep the edit natural.  ", "replace the sky"))
      .toBe("Keep the edit natural.\n\nreplace the sky");
    expect(applySystemPrompt("", "replace the sky")).toBe("replace the sky");
  });
});
