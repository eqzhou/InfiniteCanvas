import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import type { PromptItem } from "@/types/board";
import { PromptDetailDialog, PromptDetailDialogContent } from "./PromptDetailDialog";

const originalBody = [
  "# Cinematic prompt",
  "",
  "- **soft light**",
  "- `35mm`",
  "",
  "~~deprecated~~",
  "",
  "| Lens | Aperture |",
  "| --- | --- |",
  "| 35mm | f/2 |",
  "",
  "[safe](https://example.com/reference)",
  "[unsafe](javascript:alert('xss'))",
  "[data URL](data:text/plain,unsafe)",
  "[VBScript](vbscript:msgbox('xss'))",
  "",
  "![remote image](https://tracker.example/pixel.png)",
  "",
  "<img src=\"https://tracker.example/raw.png\" onerror=\"alert(1)\">",
].join("\n");

const prompt: PromptItem = {
  id: "prompt-1",
  title: "安全 Markdown",
  body: originalBody,
  tags: ["lighting"],
  source: "test",
};

const noop = () => undefined;

function createDialog(overrides: Partial<Parameters<typeof PromptDetailDialog>[0]> = {}) {
  return (
    <PromptDetailDialog
      prompt={prompt}
      open
      onClose={noop}
      onCopy={noop}
      onAddAsset={noop}
      onInsert={noop}
      {...overrides}
    />
  );
}

describe("PromptDetailDialog", () => {
  test("renders GFM while dropping raw HTML, dangerous links, and remote body images", () => {
    const html = renderToStaticMarkup(createDialog());

    expect(html).toContain("<h1>Cinematic prompt</h1>");
    expect(html).toContain("<strong>soft light</strong>");
    expect(html).toContain("<del>deprecated</del>");
    expect(html).toContain("<table");
    expect(html).toContain('<a href="https://example.com/reference"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain('href="vbscript:');
    expect(html).toContain("<span>unsafe</span>");
    expect(html).toContain("<span>data URL</span>");
    expect(html).toContain("<span>VBScript</span>");
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("unsafe");
    expect(html).toContain("[图片]");
  });

  test("leaves copy and insert actions connected to the parent's original body", () => {
    const received: string[] = [];
    const element = PromptDetailDialogContent({
      prompt,
      open: true,
      onClose: noop,
      onCopy: () => received.push(prompt.body),
      onAddAsset: noop,
      onInsert: () => received.push(prompt.body),
    });
    const actions = new Map<string, () => void>();

    const visit = (node: ReactNode) => {
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const item = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
      if (item.type === "button" && typeof item.props.children === "string" && item.props.onClick) {
        actions.set(item.props.children, item.props.onClick);
      }
      const children = item.props.children;
      for (const child of Array.isArray(children) ? children : [children]) visit(child);
    };

    visit(element);
    actions.get("复制提示词")?.();
    actions.get("插入当前画布文本节点")?.();

    expect(received).toEqual([originalBody, originalBody]);
    expect(prompt.body).toBe(originalBody);
  });
});
