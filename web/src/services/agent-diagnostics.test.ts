import { describe, expect, test } from "bun:test";

import {
  filterAgentDiagnostics,
  isAgentLogNearBottom,
  structureAgentDiagnostics,
} from "./agent-diagnostics";

describe("agent diagnostics", () => {
  test("collapses only consecutive duplicate events and preserves their details", () => {
    const entries = structureAgentDiagnostics([
      "执行命令 · running · bun test",
      "执行命令 · running · bun test",
      "读取文件 · completed · web/src/App.tsx",
      "执行命令 · running · bun test",
    ]);

    expect(entries).toEqual([
      {
        id: "diagnostic-0",
        level: "activity",
        summary: "执行命令",
        detail: "running · bun test",
        count: 2,
      },
      {
        id: "diagnostic-2",
        level: "activity",
        summary: "读取文件",
        detail: "completed · web/src/App.tsx",
        count: 1,
      },
      {
        id: "diagnostic-3",
        level: "activity",
        summary: "执行命令",
        detail: "running · bun test",
        count: 1,
      },
    ]);
  });

  test("classifies errors and warnings for fixed filters", () => {
    const entries = structureAgentDiagnostics([
      "Codex: permission denied",
      "事件流中断，重连中：EOF",
      "已请求停止当前 turn",
    ]);

    expect(filterAgentDiagnostics(entries, "errors").map((entry) => entry.summary))
      .toEqual(["Codex: permission denied"]);
    expect(filterAgentDiagnostics(entries, "warnings").map((entry) => entry.summary))
      .toEqual(["事件流中断，重连中：EOF"]);
    expect(filterAgentDiagnostics(entries, "activity").map((entry) => entry.summary))
      .toEqual(["已请求停止当前 turn"]);
  });

  test("pauses following only after the reader leaves the bottom threshold", () => {
    expect(isAgentLogNearBottom({ scrollHeight: 500, scrollTop: 260, clientHeight: 200 })).toBe(true);
    expect(isAgentLogNearBottom({ scrollHeight: 500, scrollTop: 259, clientHeight: 200 })).toBe(false);
  });
});
