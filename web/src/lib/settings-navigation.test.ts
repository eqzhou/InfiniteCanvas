import { describe, expect, test } from "bun:test";
import {
  personalChannelEditableFor,
  settingsChannelImportLockedFor,
  settingsHorizontalScrollTarget,
  settingsImportEnabledFor,
  settingsScrollTarget,
  settingsSectionsFor,
  settingsWorkspacePermissions,
} from "./settings-navigation";

describe("settings navigation", () => {
  test("keeps a compact personal settings outline for owners and members", () => {
    const memberSections = settingsSectionsFor(false);
    const ownerSections = settingsSectionsFor(true);

    expect(memberSections.map((section) => section.id)).toEqual([
      "interface",
      "models",
      "generation",
      "usage",
      "toolbar",
      "data",
    ]);
    expect(ownerSections.map((section) => section.id)).toEqual(memberSections.map((section) => section.id));
    expect(ownerSections.some((section) => section.id === "policy")).toBe(false);
  });

  test("reserves tenant-wide import, backup, and restore for the tenant owner", () => {
    expect(settingsWorkspacePermissions(false)).toEqual({
      importCompleteProject: false,
      exportCompleteWorkspace: false,
      restoreCompleteWorkspace: false,
    });
    expect(settingsWorkspacePermissions(true)).toEqual({
      importCompleteProject: true,
      exportCompleteWorkspace: true,
      restoreCompleteWorkspace: true,
    });
  });

  test("does not treat a policy lookup failure as an Owner lock, but still fail-closes channel edits", () => {
    expect(personalChannelEditableFor(false, "unavailable", false)).toBe(false);
    expect(personalChannelEditableFor(false, "loading", false)).toBe(false);
    expect(personalChannelEditableFor(false, "ready", false)).toBe(false);
    expect(personalChannelEditableFor(false, "ready", true)).toBe(true);
    expect(personalChannelEditableFor(true, "ready", false)).toBe(true);
    expect(personalChannelEditableFor(true, "unavailable", false)).toBe(true);
  });

  test("keeps preference import available after a policy lookup failure", () => {
    expect(settingsImportEnabledFor(false, "loading")).toBe(false);
    expect(settingsImportEnabledFor(false, "unavailable")).toBe(true);
    expect(settingsImportEnabledFor(false, "ready")).toBe(true);
    expect(settingsChannelImportLockedFor(false, "loading", true)).toBe(true);
    expect(settingsChannelImportLockedFor(false, "unavailable", false)).toBe(true);
    expect(settingsChannelImportLockedFor(false, "ready", false)).toBe(true);
    expect(settingsChannelImportLockedFor(false, "ready", true)).toBe(false);
    expect(settingsChannelImportLockedFor(true, "ready", false)).toBe(false);
  });

  test("calculates a container-local scroll target and never scrolls above the start", () => {
    expect(settingsScrollTarget(240, 100, 460)).toBe(584);
    expect(settingsScrollTarget(0, 100, 80)).toBe(0);
  });

  test("centers the active mobile section within the available horizontal range", () => {
    expect(settingsHorizontalScrollTarget(100, 10, 300, 250, 80, 500)).toBe(230);
    expect(settingsHorizontalScrollTarget(0, 10, 300, 0, 80, 500)).toBe(0);
    expect(settingsHorizontalScrollTarget(480, 10, 300, 500, 80, 500)).toBe(500);
  });
});