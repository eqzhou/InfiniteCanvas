import { describe, expect, test } from "bun:test";
import {
  filterCanvasPrompts,
  groupCanvasPromptsBySource,
} from "@/components/canvas/CanvasPromptsPanel";
import type { PromptItem } from "@/types/board";

const items: PromptItem[] = [
  {
    id: "1",
    title: "夜景",
    body: "neon alley",
    tags: ["city"],
    source: "Banana Prompt Quicker",
    sourceId: "banana",
  },
  {
    id: "2",
    title: "海报",
    body: "product poster",
    tags: ["work"],
    source: "local",
  },
];

describe("canvas prompt library helpers", () => {
  test("groups prompts by source", () => {
    expect(groupCanvasPromptsBySource(items).map((group) => group.source)).toEqual([
      "Banana Prompt Quicker",
      "local",
    ]);
  });

  test("filters across sources by title body tags and source name", () => {
    expect(filterCanvasPrompts(items, "banana").map((item) => item.id)).toEqual(["1"]);
    expect(filterCanvasPrompts(items, "poster").map((item) => item.id)).toEqual(["2"]);
    expect(filterCanvasPrompts(items, "city").map((item) => item.id)).toEqual(["1"]);
    expect(filterCanvasPrompts(items, "  ").map((item) => item.id)).toEqual(["1", "2"]);
  });
});
