import { afterEach, describe, expect, test } from "bun:test";
import {
  __analyticsActiveForTests,
  __resetAnalyticsForTests,
  initAnalytics,
  trackPageview,
} from "@/lib/analytics";

afterEach(() => {
  __resetAnalyticsForTests();
});

describe("optional analytics", () => {
  test("does nothing when no analytics IDs are configured", () => {
    initAnalytics();
    expect(__analyticsActiveForTests()).toEqual({ ga4: false, baidu: false });
    trackPageview("/prompts");
  });
});
