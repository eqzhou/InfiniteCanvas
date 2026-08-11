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

  test("keeps every rendered application surface free of hardcoded visible Chinese", async () => {
    const files: string[] = [];
    const glob = new Bun.Glob("**/*.tsx");
    for await (const file of glob.scan({ cwd: sourceRoot })) {
      if (!file.includes(".test.") && !file.includes("__tests__")) files.push(file);
    }
    files.sort();
    const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [
      file,
      await Bun.file(path.join(sourceRoot, file)).text(),
    ])));
    const violations = findHardcodedUserFacingChinese(sources);

    expect(violations).toEqual([]);
  });

  test("detects Chinese hidden in conditional UI expressions and error setters", () => {
    const violations = findHardcodedUserFacingChinese({
      "Example.tsx": `function Example({ ok }) { const [error, setError] = useState(""); setError("保存失败"); return <button>{ok ? "保存" : "重试"}</button>; }`,
    });
    expect(violations.map((item) => item.text)).toEqual(["保存失败", "保存", "重试"]);
  });
});
