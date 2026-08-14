import { describe, expect, test } from "bun:test";
import { normalizeAICallLogRetentionDays } from "./ai-call-log-ui";

describe("AI call log retention controls", () => {
  test("clamps invalid and out-of-range retention values", () => {
    expect(normalizeAICallLogRetentionDays(Number.NaN)).toBe(30);
    expect(normalizeAICallLogRetentionDays(0)).toBe(30);
    expect(normalizeAICallLogRetentionDays(-10)).toBe(1);
    expect(normalizeAICallLogRetentionDays(30.9)).toBe(30);
    expect(normalizeAICallLogRetentionDays(10_000)).toBe(3650);
  });
});
