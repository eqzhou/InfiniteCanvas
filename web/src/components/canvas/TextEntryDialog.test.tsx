import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TextEntryDialogContent } from "./TextEntryDialog";

describe("TextEntryDialogContent", () => {
  test("renders an in-app continuation prompt with a guarded submit action", () => {
    const html = renderToStaticMarkup(
      <TextEntryDialogContent
        title="基于此图继续创作"
        label="创作要求"
        submitLabel="生成新图片"
        placeholder="描述希望基于当前图片进行的修改或延展…"
        value=""
        onValueChange={() => undefined}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("基于此图继续创作");
    expect(html).toContain("创作要求");
    expect(html).toContain("生成新图片");
    expect(html).toContain("disabled");
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="长提示词编辑器"');
    expect(html).toContain("0 字符");
  });
});
