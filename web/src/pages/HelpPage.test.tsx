import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { HELP_SECTIONS, HelpPage } from "./HelpPage";

describe("HelpPage", () => {
  test("covers every core product workflow with stable section anchors", () => {
    expect(HELP_SECTIONS.map((section) => section.id)).toEqual([
      "signin",
      "canvas",
      "nodes",
      "prompts",
      "assets",
      "workbench",
      "agent-skills",
      "director",
      "auth-modes",
    ]);

    const html = renderToStaticMarkup(<MemoryRouter><HelpPage /></MemoryRouter>);
    for (const section of HELP_SECTIONS) {
      expect(html).toContain(`href="#${section.id}"`);
      expect(html).toContain(`id="${section.id}"`);
      expect(html).toContain(section.title);
    }
  });

  test("uses accessible navigation and points guidance back to product surfaces", () => {
    const html = renderToStaticMarkup(<MemoryRouter><HelpPage /></MemoryRouter>);

    expect(html).toContain("<h1");
    expect(html).toContain('aria-label="帮助主题"');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/assets"');
    expect(html).toContain('href="/prompts"');
    expect(html).toContain('href="/workbench/image"');
    expect(html).toContain("auth-off");
    expect(html).toContain("账号模式");
    expect(html).toContain("登录墙");
  });
});
