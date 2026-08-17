import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedChannelManagedNotice, SettingsModal, UsageOverview } from "./SettingsModal";
import { I18nProvider } from "@/i18n/I18nProvider";

describe("UsageOverview", () => {
  test("separates team generations, personal credits, and server media storage", () => {
    const html = renderToStaticMarkup(<UsageOverview snapshot={{
      plan: "free", generationThisMonth: 2, generationQuotaMonthly: 0, credits: 0,
      storageBytes: 1_572_864, storageQuotaBytes: 10_485_760,
    }} onRefresh={() => {}} />);

    expect(html).toContain("团队月生成额度（次数）");
    expect(html).toContain("2 / 0");
    expect(html).toContain("个人算力余额（credits）");
    expect(html).toContain(">0<");
    expect(html).toContain("服务端媒体存储");
    expect(html).toContain("1.5 MB / 10 MB");
    expect(html).not.toContain("无限");
  });
});

describe("SharedChannelManagedNotice", () => {
  test("explains that shared channel credentials are managed by the Owner without rendering a key field", () => {
    const html = renderToStaticMarkup(<SharedChannelManagedNotice channelName="生产生图" />);

    expect(html).toContain("生产生图");
    expect(html).toContain("Owner 已配置");
    expect(html).not.toContain("API Key");
    expect(html).not.toContain("server-managed");
  });
});

describe("settings chrome", () => {
  test("keeps notices in the dialog chrome instead of after the last section", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <SettingsModal open onClose={() => {}} />
      </I18nProvider>,
    );
    const noticeIndex = html.indexOf("data-settings-notice");
    const lastSection = html.indexOf('data-section-id="data"');
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(lastSection).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(lastSection);
    expect(html).toContain("模型与渠道");
    expect(html).toContain("数据与备份");
    expect(html).not.toContain('data-section-id="webdav"');
  });
});
