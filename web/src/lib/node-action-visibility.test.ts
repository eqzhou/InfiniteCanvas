import { describe, expect, test } from "bun:test";
import type { NodeType } from "@/types/board";
import { showsFloatingNodeActions } from "./node-action-visibility";

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
});
