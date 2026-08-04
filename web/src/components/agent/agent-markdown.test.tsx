import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentMarkdownMessage } from "./agent-markdown";

describe("Agent Markdown code blocks", () => {
  test("keeps line breaks in multi-line fenced code when code decorations are closed", () => {
    const markup = renderToStaticMarkup(
      <AgentMarkdownMessage text={"```ts\nconst first = 1;\nconst second = 2;\n```"} />,
    );

    expect(markup).toContain("data-agent-code-block");
    expect(markup).toContain("const first = 1;\nconst second = 2;");
    expect(markup).not.toContain("const first = 1;const second = 2;");
  });
});
