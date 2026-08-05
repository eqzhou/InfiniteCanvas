import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasToolbar } from "@/components/canvas/CanvasToolbar";

describe("CanvasToolbar", () => {
  test("exposes the visible canvas export action", () => {
    const html = renderToStaticMarkup(
      <CanvasToolbar
        onAdd={() => undefined}
        onImportImages={() => undefined}
        onExportSnapshot={() => Promise.resolve()}
      />,
    );

    expect(html).toContain('aria-label="导出画布"');
    expect(html).toContain('title="导出画布"');
  });
});
