import { describe, expect, test } from "bun:test";
import {
  clampWorkflowEntryPosition,
  defaultWorkflowEntryPosition,
  parseWorkflowEntryPosition,
} from "./draggable-workflow-entry";

describe("draggable workflow entry", () => {
  test("clamps the entry inside the visible viewport", () => {
    expect(clampWorkflowEntryPosition({ x: -20, y: 900 }, { width: 800, height: 600 }))
      .toEqual({ x: 12, y: 540 });
  });

  test("accepts only finite persisted coordinates", () => {
    expect(parseWorkflowEntryPosition('{"x":120,"y":80}')).toEqual({ x: 120, y: 80 });
    expect(parseWorkflowEntryPosition('{"x":"120","y":80}')).toBeNull();
    expect(parseWorkflowEntryPosition("not-json")).toBeNull();
    expect(parseWorkflowEntryPosition(null)).toBeNull();
    expect(parseWorkflowEntryPosition('{"x":120,"y":null}')).toBeNull();
  });

  test("places the default entry inside large and small viewports", () => {
    expect(defaultWorkflowEntryPosition({ width: 800, height: 600 }))
      .toEqual({ x: 600, y: 528 });
    expect(defaultWorkflowEntryPosition({ width: 80, height: 40 }))
      .toEqual({ x: 12, y: 12 });
  });
});
