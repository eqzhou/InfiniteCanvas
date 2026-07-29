import { describe, expect, it } from "vitest";
import { normalizeChannel } from "@/lib/ai-config";
import { createDefaultChannel } from "@/lib/defaults";

describe("personal channel timeout", () => {
  it("defaults new and legacy channels to 60 seconds", () => {
    expect(createDefaultChannel().timeoutSeconds).toBe(60);
    const legacy = createDefaultChannel();
    delete legacy.timeoutSeconds;
    expect(normalizeChannel(legacy).timeoutSeconds).toBe(60);
  });

  it("preserves valid values and normalizes invalid values without mutating input", () => {
    const input = { ...createDefaultChannel(), timeoutSeconds: 90 };
    expect(normalizeChannel(input).timeoutSeconds).toBe(90);
    expect(input.timeoutSeconds).toBe(90);

    for (const timeoutSeconds of [0, 601, 1.5, Number.NaN]) {
      expect(normalizeChannel({ ...input, timeoutSeconds }).timeoutSeconds).toBe(60);
    }
  });
});
