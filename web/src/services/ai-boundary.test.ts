import { describe, expect, test } from "bun:test";

const unifiedTransportConsumers = [
  "ai-client.ts",
  "ai-adapters.ts",
  "image-transform/providers/openai-images.ts",
];

const textGenerationConsumers = [
  "../components/assistant/AssistantPanel.tsx",
  "../components/canvas/NodeActions.tsx",
  "../components/canvas/NodePromptBar.tsx",
  "../components/canvas/PluginNodeFrame.tsx",
  "../components/workflows/WorkflowWorkbench.tsx",
  "../lib/plugin-host-executor.ts",
  "text-batch.ts",
];

describe("AI provider boundary", () => {
  test("keeps provider HTTP calls behind the shared transport", async () => {
    for (const relativePath of unifiedTransportConsumers) {
      const source = await Bun.file(new URL(relativePath, import.meta.url)).text();
      expect(source).toContain("@/services/provider-http");
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });

  test("keeps UI text generation behind the shared AI client", async () => {
    for (const relativePath of textGenerationConsumers) {
      const source = await Bun.file(new URL(relativePath, import.meta.url)).text();
      expect(source).not.toMatch(/\/responses|\/chat\/completions|:generateContent/);
      expect(source).not.toMatch(/\b(providerFetch|providerFetchUrl|fetch)\s*\(/);
    }
  });

  test("keeps canvas generation inputs inside the application UI", async () => {
    const source = await Bun.file(
      new URL("../components/canvas/NodeActions.tsx", import.meta.url),
    ).text();

    expect(source).not.toMatch(/\bwindow\.(?:prompt|confirm)\s*\(/);
  });
});
