import { describe, expect, test } from "bun:test";
import path from "node:path";

import { findHardcodedUserFacingChinese } from "../source-guard";
import { agentHelpEnUS, agentHelpZhCN, createAgentHelpTranslator } from "./agent-help";

const sourceRoot = path.resolve(import.meta.dir, "../..");

describe("agent, help, and authentication localization", () => {
  test("provides placeholder-compatible English messages", () => {
    expect(Object.keys(agentHelpEnUS).sort()).toEqual(Object.keys(agentHelpZhCN).sort());

    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
      .map((match) => match[1])
      .sort();
    for (const key of Object.keys(agentHelpZhCN)) {
      expect(placeholders(agentHelpEnUS[key as keyof typeof agentHelpEnUS]))
        .toEqual(placeholders(agentHelpZhCN[key as keyof typeof agentHelpZhCN]));
    }
  });

  test("uses the scoped English fallback until core registration is completed", () => {
    const t = createAgentHelpTranslator(() => { throw new Error("not registered"); }, "en-US");
    expect(t("agent.sessionCount", { count: 3 })).toBe("3 sessions");
    expect(t("auth.login")).toBe("Sign in");
    expect(t("help.title")).toBe("Help");
  });

  test("keeps the migrated surfaces free of hardcoded visible Chinese", async () => {
    const files = [
      "components/agent/AgentDiagnosticLog.tsx",
      "components/agent/AgentJumpToLatest.tsx",
      "components/agent/BrowserRuntime.tsx",
      "components/agent/ClaudePanel.tsx",
      "components/agent/CodexModelControls.tsx",
      "components/agent/CodexPanel.tsx",
      "components/agent/CodexProgressList.tsx",
      "components/agent/CodexSkillsPanel.tsx",
      "components/agent/LocalAgentPanel.tsx",
      "components/agent/agent-markdown.tsx",
      "components/auth/AuthGate.tsx",
      "components/auth/AuthPanel.tsx",
      "pages/HelpPage.tsx",
    ];
    const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [
      file,
      await Bun.file(path.join(sourceRoot, file)).text(),
    ])));

    expect(findHardcodedUserFacingChinese(sources)).toEqual([]);
  });
});
