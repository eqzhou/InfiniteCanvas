import { describe, expect, test, beforeEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal } from "./SettingsModal";
import { useBoardStore } from "@/stores/use-board-store";
import { I18nProvider } from "@/i18n/I18nProvider";

describe("SettingsModal Theme Integration", () => {
  beforeEach(() => {
    useBoardStore.setState({
      config: {
        ...useBoardStore.getState().config,
        theme: "system",
      },
    });
  });

  test("renders theme selector with all 3 options (light, dark, system)", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <SettingsModal open={true} onClose={() => {}} />
      </I18nProvider>
    );

    // Verify theme labels in the markup
    expect(html).toContain("界面主题");
    expect(html).toContain("浅色模式");
    expect(html).toContain("深色模式");
    expect(html).toContain("跟随系统");
    expect(html).toContain('role="radiogroup"');
  });

  test("marks active theme option correctly in markup", () => {
    useBoardStore.setState({
      config: {
        ...useBoardStore.getState().config,
        theme: "dark",
      },
    });

    const html = renderToStaticMarkup(
      <I18nProvider>
        <SettingsModal open={true} onClose={() => {}} />
      </I18nProvider>
    );

    expect(html).toContain('data-active="true"');
  });
});
