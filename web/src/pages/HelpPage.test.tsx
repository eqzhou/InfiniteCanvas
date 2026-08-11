import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { HELP_SECTION_IDS, HelpPage, getHelpSections } from "./HelpPage";
import { agentHelpEnUS } from "@/i18n/messages/agent-help";

describe("HelpPage", () => {
  test("covers every core product workflow with stable section anchors", () => {
    expect(HELP_SECTION_IDS).toEqual([
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

    const sections = getHelpSections((key, params) => {
      let value = agentHelpEnUS[key];
      for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement));
      return value;
    });
    const html = renderToStaticMarkup(<MemoryRouter><HelpPage /></MemoryRouter>);
    for (const section of sections) {
      expect(html).toContain(`href="#${section.id}"`);
      expect(html).toContain(`id="${section.id}"`);
    }
    expect(sections.find((section) => section.id === "signin")?.title).toBe("Sign in and get started");
  });

  test("uses accessible navigation and points guidance back to product surfaces", () => {
    const html = renderToStaticMarkup(<MemoryRouter><HelpPage /></MemoryRouter>);

    expect(html).toContain("<h1");
    expect(html).toContain("<nav");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/assets"');
    expect(html).toContain('href="/prompts"');
    expect(html).toContain('href="/workbench/image"');
    expect(html).toContain("auth-off");
    expect(html).toContain('id="auth-modes"');
  });
});
