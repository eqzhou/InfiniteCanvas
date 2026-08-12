import { afterEach, describe, expect, test } from "bun:test";
import {
  __analyticsActiveForTests,
  __resetAnalyticsForTests,
  initAnalytics,
  stripInviteFromUrl,
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

  test("removes invite tokens from query and fragment URLs", () => {
    expect(stripInviteFromUrl("/?invite=query-token", "https://board.example/"))
      .toBe("/");
    expect(stripInviteFromUrl("https://board.example/#invite=fragment-token&mode=register"))
      .toBe("https://board.example/#mode=register");
  });
});
