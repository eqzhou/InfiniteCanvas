import { describe, expect, test } from "bun:test";
import path from "node:path";

import { catalogDiagnostics } from "./core";
import { findHardcodedUserFacingChinese } from "./source-guard";

const sourceRoot = path.resolve(import.meta.dir, "..");

describe("frontend localization guard", () => {
  test("ships a complete, placeholder-compatible English catalog", () => {
    expect(catalogDiagnostics()).toEqual({
      missingEnglish: [],
      placeholderMismatches: [],
    });
  });

  test("keeps the application shell and navigation free of hardcoded visible Chinese", async () => {
    const files = [
      "App.tsx",
      "components/layout/TopNav.tsx",
      "components/layout/SettingsModal.tsx",
      "components/layout/ShortcutsModal.tsx",
      "components/admin/AdminChannelsPanel.tsx",
      "components/admin/AdminLibraryPanel.tsx",
      "components/admin/AdminPromptCatalogPanel.tsx",
      "components/admin/AdminStoragePoolPanel.tsx",
      "components/workbench/CreativeWorkbench.tsx",
      "components/workflows/WorkflowWorkbench.tsx",
      "components/film/FilmStyleTemplateLibrary.tsx",
      "components/film/ManuscriptAssetsPanels.tsx",
      "pages/AssetsPage.tsx",
      "pages/AICallLogsPage.tsx",
      "pages/AdminPage.tsx",
      "pages/HomePage.tsx",
      "pages/FilmWorkbenchPage.tsx",
      "pages/PluginsPage.tsx",
      "pages/ServerLibraryPage.tsx",
      "pages/TaskCenterPage.tsx",
      "pages/WorkflowWorkbenchPage.tsx",
    ];
    const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [
      file,
      await Bun.file(path.join(sourceRoot, file)).text(),
    ])));
    const violations = findHardcodedUserFacingChinese(sources);

    expect(violations).toEqual([]);
  });
});
