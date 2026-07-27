import { describe, expect, test } from "bun:test";
import { formatUsageChip } from "./auth-session";

describe("formatUsageChip", () => {
  test("shows plan and monthly generation quota", () => {
    expect(formatUsageChip({
      storageBytes: 0,
      generationThisMonth: 3,
      storageQuotaBytes: 1000,
      generationQuotaMonthly: 100,
      plan: "pro",
    })).toBe("pro · 本月生成 3/100");
  });

  test("surfaces the credit balance when the server reports one", () => {
    // Credits are what gate generation (402). Hiding them forces users to discover
    // an empty balance only by being refused mid-run.
    expect(formatUsageChip({
      storageBytes: 0,
      generationThisMonth: 3,
      storageQuotaBytes: 1000,
      generationQuotaMonthly: 100,
      plan: "pro",
      credits: 42,
    })).toBe("pro · 本月生成 3/100 · 算力 42");
  });

  test("treats zero credits as a real balance, not as missing", () => {
    expect(formatUsageChip({
      storageBytes: 0,
      generationThisMonth: 0,
      storageQuotaBytes: 1000,
      generationQuotaMonthly: 10,
      plan: "free",
      credits: 0,
    })).toBe("free · 本月生成 0/10 · 算力 0");
  });
});
