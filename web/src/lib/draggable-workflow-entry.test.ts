import { describe, expect, it } from "vitest";
import {
  clampWorkflowEntryPosition,
  parseWorkflowEntryPosition,
} from "./draggable-workflow-entry";

describe("draggable workflow entry", () => {
  it("clamps the entry inside the visible viewport", () => {
    expect(clampWorkflowEntryPosition({ x: -20, y: 900 }, { width: 800, height: 600 }))
      .toEqual({ x: 12, y: 540 });
  });

  it("accepts only finite persisted coordinates", () => {
    expect(parseWorkflowEntryPosition('{"x":120,"y":80}')).toEqual({ x: 120, y: 80 });
    expect(parseWorkflowEntryPosition('{"x":"120","y":80}')).toBeNull();
    expect(parseWorkflowEntryPosition("not-json")).toBeNull();
  });
});
