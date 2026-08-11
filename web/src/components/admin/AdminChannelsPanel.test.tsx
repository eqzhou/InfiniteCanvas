import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminChannelModelDiffReview,
  AdminChannelNameField,
  AdminMediaCapabilityEditor,
  adminChannelCanTest,
  emptyAdminChannel,
} from "./AdminChannelsPanel";

describe("AdminChannelModelDiffReview", () => {
  test("generates opaque stable IDs while exposing only the user-facing name", () => {
    const first = emptyAdminChannel(1);
    const second = emptyAdminChannel(2);
    const html = renderToStaticMarkup(
      <AdminChannelNameField channel={first} onChange={() => undefined} />,
    );

    expect(first.id).toMatch(/^shared_[A-Za-z0-9_-]{10}$/);
    expect(second.id).toMatch(/^shared_[A-Za-z0-9_-]{10}$/);
    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe("共享渠道 1");
    expect(html).toContain("渠道名称（用户可见）");
    expect(html).toContain('value="共享渠道 1"');
    expect(html).not.toContain(first.id);
    expect(html).not.toContain("渠道 ID");
  });

  test("allows keyless Edge channels to run the connection test", () => {
    expect(adminChannelCanTest({ protocol: "edge", secretConfigured: false })).toBe(true);
    expect(adminChannelCanTest({ protocol: "azure", secretConfigured: false })).toBe(false);
    expect(adminChannelCanTest({ protocol: "openai", secretConfigured: true })).toBe(true);
  });

  test("shows new, existing, and removed models as an explicit confirmation step", () => {
    const html = renderToStaticMarkup(
      <AdminChannelModelDiffReview
        diff={{
          added: ["new-video"],
          existing: ["gpt-4.1"],
          removed: ["legacy-image"],
          selected: ["new-video", "gpt-4.1"],
        }}
        selected={["new-video", "gpt-4.1"]}
        onToggle={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("新获取（1）");
    expect(html).toContain("已有（1）");
    expect(html).toContain("已移除（1）");
    expect(html).toContain("new-video");
    expect(html).toContain("gpt-4.1");
    expect(html).toContain("legacy-image");
    expect(html).toContain("确认更新模型");
    expect(html.match(/checked=""/g)?.length).toBe(2);
  });

  test("explains an empty fetched catalog before allowing a destructive clear", () => {
    const html = renderToStaticMarkup(
      <AdminChannelModelDiffReview
        diff={{ added: [], existing: [], removed: ["configured-model"], selected: [] }}
        selected={[]}
        onToggle={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("拉取结果为空");
    expect(html).toContain("configured-model");
    expect(html).toContain("确认更新模型");
  });

  test("renders explicit per-model media capabilities without exposing channel internals", () => {
    const html = renderToStaticMarkup(
      <AdminMediaCapabilityEditor
        models={["gpt-image-1", "video-pro"]}
        capabilities={[{
          model: "gpt-image-1",
          kind: "image",
          modes: ["text_to_image", "image_to_image"],
          sizes: ["1024x1024"],
          durations: [],
          maxReferences: 4,
        }]}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("媒体模型能力");
    expect(html).toContain("gpt-image-1");
    expect(html).toContain("图生图");
    expect(html).toContain("1024x1024");
    expect(html).toContain("尺寸 / 画幅 / 清晰度");
    expect(html).toContain("如 1024x1024、16:9、720p");
    expect(html).toContain("添加能力");
    expect(html).not.toContain("apiKey");
  });
});
