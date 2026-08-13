import { describe, expect, test } from "bun:test";
import { normalizeInvitationExpiryHours } from "./TenantInvitationsPanel";

describe("normalizeInvitationExpiryHours", () => {
  test("accepts integer values within the API range", () => {
    expect(normalizeInvitationExpiryHours("168")).toBe(168);
    expect(normalizeInvitationExpiryHours("1")).toBe(1);
    expect(normalizeInvitationExpiryHours("720")).toBe(720);
  });

  test("rejects empty, fractional, and out-of-range values", () => {
    expect(normalizeInvitationExpiryHours("")).toBeNull();
    expect(normalizeInvitationExpiryHours("1.5")).toBeNull();
    expect(normalizeInvitationExpiryHours("0")).toBeNull();
    expect(normalizeInvitationExpiryHours("721")).toBeNull();
  });
});
