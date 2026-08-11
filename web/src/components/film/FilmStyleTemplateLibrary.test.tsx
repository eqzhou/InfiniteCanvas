import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FilmStyleTemplateLibrary } from "./FilmStyleTemplateLibrary";

describe("Film style template library", () => {
  test("exposes accessible apply and copy actions in a responsive catalog", () => {
    const html = renderToStaticMarkup(<FilmStyleTemplateLibrary busy={false} onApply={() => undefined} onCopy={() => undefined} />);

    expect(html).toContain('aria-label="原创影视风格参考模板"');
    expect(html).toContain('data-testid="film-style-template-mist-harbor-documentary"');
    expect(html).toContain("应用到当前项目");
    expect(html).toContain("复制为影视项目");
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("focus-visible:");
  });
});
