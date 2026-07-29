import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IMAGE_TOOLBAR_PREFERENCES,
  IMAGE_TOOLBAR_ACTIONS,
  IMAGE_TOOLBAR_PREFERENCES_VERSION,
  normalizeImageToolbarPreferences,
  orderedVisibleImageActions,
} from "./image-toolbar-preferences";

describe("image toolbar preferences", () => {
  test("normalizes unknown, duplicate and missing actions without mutating input", () => {
    const input = {
      order: ["crop", "unknown", "crop", "download"],
      hidden: ["rotate", "unknown", "rotate"],
      showLabels: false,
    };
    const snapshot = structuredClone(input);
    const normalized = normalizeImageToolbarPreferences(input);

    expect(input).toEqual(snapshot);
    expect(normalized.order.slice(0, 2)).toEqual(["crop", "download"]);
    expect(new Set(normalized.order)).toEqual(new Set(IMAGE_TOOLBAR_ACTIONS));
    expect(normalized.hidden).toEqual(["rotate"]);
    expect(normalized.showLabels).toBe(false);
  });

  test("falls back to an immutable default for malformed values", () => {
    const normalized = normalizeImageToolbarPreferences({ order: "crop" });
    expect(normalized).toEqual(DEFAULT_IMAGE_TOOLBAR_PREFERENCES);
    expect(normalized).not.toBe(DEFAULT_IMAGE_TOOLBAR_PREFERENCES);
  });

  test("keeps mandatory actions visible and respects configured order", () => {
    const visible = orderedVisibleImageActions({
      order: ["download", "copy", "crop", ...IMAGE_TOOLBAR_ACTIONS.filter((id) => id !== "download" && id !== "copy" && id !== "crop")],
      hidden: ["download", "copy", "crop", "mask"],
      showLabels: true,
    });
    expect(visible[0]).toBe("download");
    expect(visible[1]).toBe("copy");
    expect(visible).not.toContain("mask");
  });

  test("migrates unversioned values and stamps the current schema version", () => {
    const migrated = normalizeImageToolbarPreferences({
      order: ["crop", "download"],
      hidden: ["rotate"],
      showLabels: true,
    });
    expect(migrated.version).toBe(IMAGE_TOOLBAR_PREFERENCES_VERSION);
    expect(migrated.hidden).toEqual(["rotate"]);
    expect(migrated.showLabels).toBe(true);
  });

  test("rejects future or malformed schema versions instead of reinterpreting them", () => {
    for (const version of [IMAGE_TOOLBAR_PREFERENCES_VERSION + 1, -1, 1.5, "1", null]) {
      const normalized = normalizeImageToolbarPreferences({
        version,
        order: ["crop"],
        hidden: ["download"],
        showLabels: true,
      });
      expect(normalized).toEqual(DEFAULT_IMAGE_TOOLBAR_PREFERENCES);
    }
  });

  test("rejects oversized persisted action lists before iterating them", () => {
    const flooded = Array.from({ length: IMAGE_TOOLBAR_ACTIONS.length * 4 + 1 }, () => "crop");
    expect(normalizeImageToolbarPreferences({ order: flooded, hidden: [], showLabels: false }))
      .toEqual(DEFAULT_IMAGE_TOOLBAR_PREFERENCES);
  });
});
