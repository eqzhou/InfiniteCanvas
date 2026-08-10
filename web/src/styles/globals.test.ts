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

describe("responsive navigation", () => {
  test("keeps full tools out of medium desktop widths and exposes the compact controls", async () => {
    const css = await Bun.file(new URL("./globals.css", import.meta.url)).text();

    expect(css).toContain("@media (min-width: 1650px)");
    expect(css).toContain(".ob-agent-shortcut");
    expect(css).toContain("@media (min-width: 768px) and (max-width: 1649px)");
    expect(css).toContain(".ob-desktop-nav-label");
    expect(css).toContain("@media (min-width: 1360px)");
  });

  test("keeps the closed mobile drawer outside the focus order", async () => {
    const source = await Bun.file(new URL("../components/layout/TopNav.tsx", import.meta.url)).text();

    expect(source).toContain("inert={!mobileNavOpen}");
    expect(source).toContain("aria-hidden={!mobileNavOpen}");
    expect(source).toContain("const previousOverflow = document.body.style.overflow");
    expect(source).toContain("mobileMenuButtonRef.current.focus()");
  });
});
