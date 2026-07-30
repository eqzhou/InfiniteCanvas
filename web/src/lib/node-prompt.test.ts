import { describe, expect, test } from "bun:test";
import { initialNodePrompt, nodePromptPlaceholder } from "./node-prompt";

describe("image prompt drafts", () => {
  test("does not reuse a generated image's request snapshot as a continuation draft", () => {
    expect(initialNodePrompt({
      type: "image",
      metadata: { content: "data:image/png;base64,test", prompt: "original image prompt" },
    })).toBe("");
  });

  test("keeps an empty image ready for its first generation", () => {
    expect(initialNodePrompt({ type: "image", metadata: { prompt: "first image prompt" } })).toBe("first image prompt");
    expect(nodePromptPlaceholder("image", true)).toContain("继续创作");
  });
});
