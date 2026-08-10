import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SharedChannelManagedNotice,
  settingsHorizontalScrollTarget,
  settingsScrollTarget,
  settingsSectionsFor,
} from "./SettingsModal";

describe("SharedChannelManagedNotice", () => {
  test("explains that shared channel credentials are managed by admins without rendering a key field", () => {
    const html = renderToStaticMarkup(<SharedChannelManagedNotice channelName="生产生图" />);

    expect(html).toContain("生产生图");
    expect(html).toContain("管理员已配置");
    expect(html).not.toContain("API Key");
    expect(html).not.toContain("server-managed");
  });
});

describe("settings section navigation", () => {
  test("exposes site policy only to administrators without mutating the base order", () => {
    const memberSections = settingsSectionsFor(false);
    const adminSections = settingsSectionsFor(true);

    expect(memberSections.map((section) => section.id)).toEqual([
      "channel",
      "model",
      "generation",
      "defaults",
      "toolbar",
      "storage",
      "configfile",
      "webdav",
    ]);
    expect(adminSections.map((section) => section.id)).toEqual([
      "channel",
      "model",
      "generation",
      "defaults",
      "policy",
      "toolbar",
      "storage",
      "configfile",
      "webdav",
    ]);
    expect(memberSections).not.toBe(adminSections);
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
