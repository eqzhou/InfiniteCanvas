import { describe, expect, test } from "bun:test";
import type { BoardNode, BoardProject } from "@/types/board";
import {
  canRegenerateImageFromPrompt,
  imagePromptInheritsFromUpstream,
  initialNodePrompt,
  nodePromptPlaceholder,
  nodePromptUsesPromptLibrary,
} from "./node-prompt";

describe("image prompt drafts", () => {
  const image = (metadata: BoardNode["metadata"] = {}): BoardNode => ({
    id: "image-result",
    type: "image",
    title: "Result",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata,
  });

  const project = (
    nodes: BoardNode[],
    edges: BoardProject["edges"] = [],
  ): BoardProject => ({
    id: "project",
    title: "Project",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    nodes,
    edges,
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    viewport: { x: 0, y: 0, k: 1 },
  });

  test("shows a generated image's prompt when no text or config node owns it", () => {
    const node = image({
      content: "data:image/png;base64,test",
      prompt: "original image prompt",
      generationType: "text-to-image",
    });

    expect(imagePromptInheritsFromUpstream(project([node]), node)).toBe(false);
    expect(initialNodePrompt(node, false)).toBe("original image prompt");
  });

  test("keeps the image prompt blank when a direct text node owns the prompt", () => {
    const text: BoardNode = {
      ...image({ content: "upstream prompt" }),
      id: "text-source",
      type: "text",
    };
    const node = image({ content: "data:image/png;base64,test", prompt: "resolved upstream prompt" });
    const board = project([text, node], [{ id: "edge", from: text.id, to: node.id }]);

    expect(imagePromptInheritsFromUpstream(board, node)).toBe(true);
    expect(initialNodePrompt(node, true)).toBe("");
  });

  test("keeps config-generated result prompts blank while preserving the request snapshot", () => {
    const config: BoardNode = {
      ...image({ prompt: "config prompt" }),
      id: "config-source",
      type: "config",
    };
    const node = image({
      content: "data:image/png;base64,test",
      prompt: "resolved config prompt",
      generationConfigId: config.id,
    });

    expect(imagePromptInheritsFromUpstream(project([config, node]), node)).toBe(true);
    expect(initialNodePrompt(node, true)).toBe("");
    expect(node.metadata.prompt).toBe("resolved config prompt");
  });

  test("shows an image-to-image result prompt when the upstream only supplies an image", () => {
    const source = { ...image({ storageKey: "source-key" }), id: "image-source" };
    const node = image({
      content: "data:image/png;base64,test",
      prompt: "change the coat to blue",
      generationType: "image-to-image",
      referenceStorageKeys: ["source-key"],
    });
    const board = project([source, node], [{ id: "edge", from: source.id, to: node.id }]);

    expect(imagePromptInheritsFromUpstream(board, node)).toBe(false);
    expect(initialNodePrompt(node, false)).toBe("change the coat to blue");
  });

  test("regenerates only generated images whose prompt is owned by the image node", () => {
    const generated = image({
      content: "data:image/png;base64,test",
      prompt: "editable prompt",
      generationType: "image-to-image",
      referenceStorageKeys: ["source-key"],
    });
    const uploaded = image({
      content: "data:image/png;base64,upload",
      storageKey: "uploaded-key",
      prompt: "new continuation",
    });

    expect(canRegenerateImageFromPrompt(generated, false)).toBe(true);
    expect(canRegenerateImageFromPrompt(generated, true)).toBe(false);
    expect(canRegenerateImageFromPrompt(uploaded, false)).toBe(false);
  });

  test("keeps an empty image ready for its first generation", () => {
    expect(initialNodePrompt(image({ prompt: "first image prompt" }), false)).toBe("first image prompt");
    expect(nodePromptPlaceholder("image", true)).toContain("继续创作");
  });

  test("keeps visual prompt presets out of audio nodes", () => {
    expect(nodePromptUsesPromptLibrary("audio")).toBe(false);
    expect(nodePromptUsesPromptLibrary("image")).toBe(true);
  });
});
