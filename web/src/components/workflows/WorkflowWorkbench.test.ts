import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKFLOW_AGENT_SYSTEM_PROMPT,
  resolveWorkflowAgentSystemPrompt,
} from "./WorkflowWorkbench";

describe("workflow agent system prompt", () => {
  test("uses the administrator instruction when one is configured", () => {
    expect(resolveWorkflowAgentSystemPrompt("  只输出 JSON  ")).toBe("只输出 JSON");
  });

  test("falls back to the built-in default when unset or blank", () => {
    // The agent must never run without guidance, so blank means "use default".
    for (const value of [undefined, "", "   "]) {
      expect(resolveWorkflowAgentSystemPrompt(value)).toBe(DEFAULT_WORKFLOW_AGENT_SYSTEM_PROMPT);
    }
  });
});
