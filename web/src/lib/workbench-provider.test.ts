import { describe, expect, test } from "bun:test";
import { createDefaultChannel } from "@/lib/defaults";
import { resolveWorkbenchRunChannel } from "./workbench-provider";

describe("workbench history provider resolution", () => {
  test("requires the exact recorded provider instead of falling back to the current channel", () => {
    const current = { ...createDefaultChannel(), id: "current", name: "Current" };
    expect(() => resolveWorkbenchRunChannel([current], current, "removed-provider"))
      .toThrow("removed-provider");
  });

  test("uses the current channel only for a new run", () => {
    const current = { ...createDefaultChannel(), id: "current", name: "Current" };
    expect(resolveWorkbenchRunChannel([current], current)?.id).toBe("current");
  });
});
