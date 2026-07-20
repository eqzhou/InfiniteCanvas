import { describe, expect, test } from "bun:test";
import { groupCanvasPromptsBySource } from "@/components/canvas/CanvasPromptsPanel";
import type { PromptItem } from "@/types/board";

const sample = (id: string, source?: string): PromptItem => ({
  id,
  title: id,
  body: `body-${id}`,
  tags: [],
  source,
});

describe("canvas prompt panel grouping", () => {
  test("groups prompts by source while preserving first-seen order", () => {
    const groups = groupCanvasPromptsBySource([
      sample("a", "local"),
      sample("b", "Community"),
      sample("c", "local"),
      sample("d"),
      sample("e", "Community"),
    ]);
    expect(groups.map((group) => group.source)).toEqual(["local", "Community", "未分组"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["a", "c"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["b", "e"]);
    expect(groups[2]?.items.map((item) => item.id)).toEqual(["d"]);
  });
});
