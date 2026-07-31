import { describe, expect, test } from "bun:test";

describe("native select theme", () => {
  test("uses application theme colors for popup options", async () => {
    const css = await Bun.file(new URL("./globals.css", import.meta.url)).text();

    expect(css).toContain("select option,");
    expect(css).toContain("select optgroup");
    expect(css).toContain("background-color: var(--ob-panel)");
    expect(css).toContain("color: var(--ob-ink)");
  });
});
