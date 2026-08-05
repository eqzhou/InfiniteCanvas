import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexSkillsPanel } from "./CodexSkillsPanel";

describe("CodexSkillsPanel", () => {
  test("exposes the management entry and safe invocation state", () => {
    const html = renderToStaticMarkup(
      <CodexSkillsPanel
        connection={{ baseUrl: "http://127.0.0.1:8790" }}
        canInvoke={false}
        onInvoke={() => undefined}
      />,
    );
    expect(html).toContain("Agent Skills");
    expect(html).toContain("新建");
    expect(html).not.toContain("完全访问");
  });
});
