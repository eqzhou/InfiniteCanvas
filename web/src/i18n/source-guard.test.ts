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
    const violations = await findHardcodedUserFacingChinese(sourceRoot, [
      "App.tsx",
      "components/layout/TopNav.tsx",
    ]);

    expect(violations).toEqual([]);
  });
});
