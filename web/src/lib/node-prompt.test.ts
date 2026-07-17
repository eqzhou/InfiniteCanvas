import { describe, expect, test } from "bun:test";
import { isNodePromptType, nodePromptKind, nodePromptPlaceholder } from "./node-prompt";

describe("node prompt behavior", () => {
  test("routes every promptable node to its matching provider", () => {
    expect(isNodePromptType("audio")).toBe(true);
    expect(isNodePromptType("config")).toBe(false);
    expect(nodePromptKind("text")).toBe("text");
    expect(nodePromptKind("image")).toBe("image");
    expect(nodePromptKind("video")).toBe("video");
    expect(nodePromptKind("audio")).toBe("audio");
  });

  test("uses an audio-specific prompt instead of video copy", () => {
    expect(nodePromptPlaceholder("audio", false)).toBe("输入语音文本…");
    expect(nodePromptPlaceholder("text", false)).toBe("输入要生成的文本…");
    expect(nodePromptPlaceholder("text", true)).toBe("描述如何改写这段文本…");
  });
});
