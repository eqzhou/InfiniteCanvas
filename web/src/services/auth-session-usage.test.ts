import { afterEach, describe, expect, mock, test } from "bun:test";
import { estimateCredits, formatEstimateSuffix, formatUsageChip } from "./auth-session";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("formatUsageChip", () => {
  test("shows plan and monthly generation quota without credits when absent", () => {
    expect(formatUsageChip({
      storageBytes: 0,
      generationThisMonth: 3,
      storageQuotaBytes: 0,
      generationQuotaMonthly: 100,
      plan: "pro",
    })).toBe("pro · 本月生成 3/100");
  });

  test("appends remaining compute credits when present", () => {
    expect(formatUsageChip({
      storageBytes: 0,
      generationThisMonth: 3,
      storageQuotaBytes: 0,
      generationQuotaMonthly: 100,
      plan: "pro",
      credits: 42,
    })).toBe("pro · 本月生成 3/100 · 算力 42");
  });

  test("treats zero credits as a real balance, not as missing", () => {
    expect(formatUsageChip({
      storageBytes: 0,
      generationThisMonth: 0,
      storageQuotaBytes: 0,
      generationQuotaMonthly: 50,
      plan: "free",
      credits: 0,
    })).toBe("free · 本月生成 0/50 · 算力 0");
  });
});

describe("estimateCredits", () => {
  test("queries billing/estimate with model and bounded units", async () => {
    let url = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(JSON.stringify({
        model: "gpt-image-1",
        units: 2,
        creditsPerUnit: 3,
        totalCredits: 6,
        balance: 20,
        sufficient: true,
      }));
    }) as typeof fetch;
    const estimate = await estimateCredits("gpt-image-1", 2);
    expect(url).toContain("billing/estimate?");
    expect(url).toContain("model=gpt-image-1");
    expect(url).toContain("units=2");
    expect(estimate).toEqual({
      model: "gpt-image-1",
      units: 2,
      creditsPerUnit: 3,
      totalCredits: 6,
      balance: 20,
      sufficient: true,
    });
  });

  test("clamps invalid units to 1", async () => {
    let url = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(JSON.stringify({
        model: "m", units: 1, creditsPerUnit: 0, totalCredits: 0, balance: 0, sufficient: true,
      }));
    }) as typeof fetch;
    await estimateCredits("m", 0);
    expect(url).toContain("units=1");
  });
});

describe("formatEstimateSuffix", () => {
  test("returns empty for free or missing estimates", () => {
    expect(formatEstimateSuffix(null)).toBe("");
    expect(formatEstimateSuffix({
      model: "m", units: 1, creditsPerUnit: 0, totalCredits: 0, balance: 10, sufficient: true,
    })).toBe("");
  });

  test("renders total credits", () => {
    expect(formatEstimateSuffix({
      model: "m", units: 2, creditsPerUnit: 3, totalCredits: 6, balance: 10, sufficient: true,
    })).toBe(" · 预计 6 算力");
  });
});
