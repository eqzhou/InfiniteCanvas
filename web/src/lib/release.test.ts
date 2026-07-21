import { describe, expect, test } from "bun:test";
import { isNewerVersion, parseChangelog } from "@/lib/release";

describe("release changelog", () => {
  test("parses versioned release blocks and item types", () => {
    const releases = parseChangelog(`# CHANGELOG

## Unreleased

+ [新增] banana

## v0.1.0 - 2026-07-21

+ [修复] bug
+ [调整] tweak
`);
    expect(releases).toEqual([
      { version: "Unreleased", date: "", items: [{ type: "新增", content: "banana" }] },
      { version: "v0.1.0", date: "2026-07-21", items: [
        { type: "修复", content: "bug" },
        { type: "调整", content: "tweak" },
      ] },
    ]);
  });

  test("compares semantic versions for update dots", () => {
    expect(isNewerVersion("v0.2.0", "v0.1.0")).toBe(true);
    expect(isNewerVersion("v0.1.0", "v0.1.0")).toBe(false);
    expect(isNewerVersion("v0.1.1", "v0.1.0")).toBe(true);
    expect(isNewerVersion("not-a-version", "v0.1.0")).toBe(false);
  });
});
