import { describe, expect, test } from "bun:test";

import {
  detectSupportedLocale,
  formatBytes,
  formatNumber,
  normalizeLocale,
  translate,
} from "./core";

describe("i18n core", () => {
  test("normalizes only supported locale identifiers", () => {
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("en-US")).toBe("en-US");
    expect(normalizeLocale("en-GB")).toBeUndefined();
    expect(normalizeLocale({ locale: "en-US" })).toBeUndefined();
  });

  test("detects a supported browser locale and otherwise falls back to Chinese", () => {
    expect(detectSupportedLocale(["fr-FR", "en-US"])).toBe("en-US");
    expect(detectSupportedLocale(["zh-Hans-CN"])).toBe("zh-CN");
    expect(detectSupportedLocale(["fr-FR"])).toBe("zh-CN");
  });

  test("translates typed messages with interpolation", () => {
    expect(translate("en-US", "nav.serverLibrary")).toBe("Server assets");
    expect(translate("en-US", "usage.generations", { current: 2, limit: 10 }))
      .toBe("Team generations 2/10");
  });

  test("formats numbers and bytes with the active locale", () => {
    expect(formatNumber("en-US", 1234)).toBe("1,234");
    expect(formatBytes("en-US", 1_572_864)).toBe("1.5 MB");
    expect(formatBytes("zh-CN", -1)).toBe("0 B");
  });
});
