import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedChannelManagedNotice } from "./SettingsModal";

describe("SharedChannelManagedNotice", () => {
  test("explains that shared channel credentials are managed by admins without rendering a key field", () => {
    const html = renderToStaticMarkup(<SharedChannelManagedNotice channelName="生产生图" />);

    expect(html).toContain("生产生图");
    expect(html).toContain("管理员已配置");
    expect(html).not.toContain("API Key");
    expect(html).not.toContain("server-managed");
  });
});
