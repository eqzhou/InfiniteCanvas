import { describe, expect, test } from "bun:test";

import {
  formatCodexElapsed,
  reduceCodexProgress,
  type CodexProgressItem,
} from "./codex-progress";

describe("Codex progress timeline", () => {
  test("merges started and completed events for the same item", () => {
    const started = reduceCodexProgress([], {
      itemId: "cmd-1",
      itemType: "commandExecution",
      label: "运行命令",
      detail: "bun test",
      status: "running",
    });
    const completed = reduceCodexProgress(started, {
      itemId: "cmd-1",
      itemType: "commandExecution",
      label: "运行命令",
      detail: "bun test",
      status: "completed",
    });

    expect(completed).toEqual<CodexProgressItem[]>([{
      id: "cmd-1",
      itemType: "commandExecution",
      label: "运行命令",
      detail: "bun test",
      status: "completed",
    }]);
  });

  test("keeps failure reasons and bounds the timeline", () => {
    let progress: CodexProgressItem[] = [];
    for (let index = 0; index < 60; index += 1) {
      progress = reduceCodexProgress(progress, {
        itemId: `tool-${index}`,
        itemType: "mcpToolCall",
        label: "调用工具",
        detail: `tool-${index}`,
        status: index === 59 ? "failed" : "completed",
        error: index === 59 ? "连接失败" : undefined,
      });
    }

    expect(progress).toHaveLength(48);
    expect(progress.at(-1)).toMatchObject({ status: "failed", error: "连接失败" });
  });

  test("appends bounded streaming reasoning or command output", () => {
    const started = reduceCodexProgress([], {
      itemId: "reasoning-1",
      itemType: "reasoning",
      label: "思考",
      detail: "先检查",
      status: "running",
    });
    const streamed = reduceCodexProgress(started, {
      itemId: "reasoning-1",
      itemType: "reasoning",
      label: "思考",
      detail: "，再验证",
      appendDetail: true,
      status: "running",
    });

    expect(streamed[0].detail).toBe("先检查，再验证");
  });

  test("formats elapsed processing time", () => {
    expect(formatCodexElapsed(0)).toBe("0 秒");
    expect(formatCodexElapsed(61_000)).toBe("1 分 1 秒");
  });
});
