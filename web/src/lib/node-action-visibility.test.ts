import { describe, expect, test } from "bun:test";
import type { BoardNode, NodeType } from "@/types/board";
import {
  shouldRenderFloatingNodeActions,
  shouldRenderNodePromptBar,
  shouldShowImageGenerationAction,
  showsFloatingNodeActions,
} from "./node-action-visibility";

function imageNode(metadata: Pick<BoardNode["metadata"], "content" | "storageKey">) {
  return { type: "image", metadata } as Pick<BoardNode, "type" | "metadata">;
}

describe("floating node action visibility", () => {
  test("shows media actions for selected panorama nodes", () => {
    expect(showsFloatingNodeActions("panorama")).toBe(true);
  });

  test("keeps container and self-managed nodes out of the shared action toolbar", () => {
    const hidden: NodeType[] = ["group", "plugin", "director"];
    expect(hidden.every((type) => !showsFloatingNodeActions(type))).toBe(true);
  });

  test("continues to show the shared toolbar for existing editable node types", () => {
    const visible: NodeType[] = ["text", "image", "config", "video", "audio"];
    expect(visible.every((type) => showsFloatingNodeActions(type))).toBe(true);
  });

  test("hides image generation for an empty image node", () => {
    expect(shouldShowImageGenerationAction(imageNode({}))).toBe(false);
  });

  test("keeps image generation for an image with uploaded content or storage", () => {
    expect(shouldShowImageGenerationAction(imageNode({ content: "data:image/png;base64,abc" }))).toBe(true);
    expect(shouldShowImageGenerationAction(imageNode({ storageKey: "image:stored" }))).toBe(true);
  });

  test("pauses the floating toolbar while a selected node is resizing", () => {
    expect(shouldRenderFloatingNodeActions("image", true, false)).toBe(true);
    expect(shouldRenderFloatingNodeActions("image", true, true)).toBe(false);
    expect(shouldRenderFloatingNodeActions("image", false, true)).toBe(false);
    expect(shouldRenderFloatingNodeActions("group", true, false)).toBe(false);
    expect(shouldRenderNodePromptBar(true, false)).toBe(true);
    expect(shouldRenderNodePromptBar(true, true)).toBe(false);
  });
});
