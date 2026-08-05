import { describe, expect, test } from "bun:test";
import {
  buildCodexSkillDraft,
  buildCodexSkillInvocationPrompt,
  type CodexSkillDraftContext,
} from "@/services/codex-skills";

const context: CodexSkillDraftContext = {
  projectName: "Marketing board",
  nodeTypes: ["TEXT", "IMAGE", "IMAGE", "GROUP"],
  goal: "Review the landing page copy and suggest concise alternatives.",
};

describe("Codex skill drafting", () => {
  test("generates a reviewable skill document from canvas context", () => {
    const draft = buildCodexSkillDraft(context);
    expect(draft.id).toBe("marketing-board-review");
    expect(draft.content).toContain("Marketing board");
    expect(draft.content).toContain("Review the landing page copy");
    expect(draft.content).toContain("## Workflow");
  });

  test("wraps explicit invocation in a bounded, visible instruction", () => {
    const prompt = buildCodexSkillInvocationPrompt({
      id: "review-code",
      name: "Review code",
      content: "# Review code\n\nCheck tests.",
    }, "Focus on the changed files.");
    expect(prompt).toContain("review-code");
    expect(prompt).toContain("Check tests.");
    expect(prompt).toContain("Focus on the changed files.");
  });

  test("keeps generated frontmatter single-line and bounds UTF-8 text", () => {
    const draft = buildCodexSkillDraft({
      projectName: "含:冒号\n和换行",
      nodeTypes: [],
      goal: "检查当前画布",
    });
    expect(draft.content).toContain("name: 含 - 冒号 和换行 Review");
    expect(draft.content).not.toContain("name: 含:冒号");
    expect(() => buildCodexSkillInvocationPrompt({
      id: "review-code",
      name: "Review code",
      content: "中".repeat(80_000),
    })).toThrow("消息大小限制");
  });
});
