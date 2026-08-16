import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SharedChannelManagedNotice,
  UsageOverview,
  settingsHorizontalScrollTarget,
  settingsScrollTarget,
  settingsSectionsFor,
  settingsWorkspacePermissions,
} from "./SettingsModal";

describe("UsageOverview", () => {
  test("separates team generations, personal credits, and server media storage", () => {
    const html = renderToStaticMarkup(<UsageOverview snapshot={{
      plan: "free", generationThisMonth: 2, generationQuotaMonthly: 0, credits: 0,
      storageBytes: 1_572_864, storageQuotaBytes: 10_485_760,
    }} onRefresh={() => {}} />);

    expect(html).toContain("团队月生成额度（次数）");
    expect(html).toContain("2 / 0");
    expect(html).toContain("个人算力余额（credits）");
    expect(html).toContain(">0<");
    expect(html).toContain("服务端媒体存储");
    expect(html).toContain("1.5 MB / 10 MB");
    expect(html).not.toContain("无限");
  });
});

describe("SharedChannelManagedNotice", () => {
  test("explains that shared channel credentials are managed by the Owner without rendering a key field", () => {
    const html = renderToStaticMarkup(<SharedChannelManagedNotice channelName="生产生图" />);

    expect(html).toContain("生产生图");
    expect(html).toContain("Owner 已配置");
    expect(html).not.toContain("API Key");
    expect(html).not.toContain("server-managed");
  });
});

describe("settings section navigation", () => {
  test("keeps the settings modal personal for owners and ordinary users", () => {
    const memberSections = settingsSectionsFor(false);
    const ownerSections = settingsSectionsFor(true);

    expect(memberSections.map((section) => section.id)).toEqual([
      "interface",
      "channel",
      "usage",
      "model",
      "generation",
      "defaults",
      "toolbar",
      "storage",
      "configfile",
      "webdav",
    ]);
    expect(ownerSections.map((section) => section.id)).toEqual([
      "interface",
      "channel",
      "usage",
      "model",
      "generation",
      "defaults",
      "toolbar",
      "storage",
      "configfile",
      "webdav",
    ]);
    expect(memberSections).not.toBe(ownerSections);
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
