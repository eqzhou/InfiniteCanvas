import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { I18nProvider } from "@/i18n/I18nProvider";
import { installBrowser, flushRenderer, fire, hostButton, hostInput, hostNodes, nodeText, renderRenderer, restoreBrowser } from "@/test/react-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import type { AssetItem } from "@/types/board";
import { AssetEditorDialog, type AssetEditorValues } from "./AssetEditorDialog";

const NOW = "2026-08-19T00:00:00.000Z";

const textAsset: AssetItem = {
  id: "asset-text",
  kind: "text",
  title: "Old title",
  tags: ["one", "two"],
  source: "old source",
  notes: "old notes",
  content: "old content",
  createdAt: NOW,
  updatedAt: NOW,
};

function mediaAsset(kind: "image" | "video" | "audio"): AssetItem {
  return {
    ...textAsset,
    id: `asset-${kind}`,
    kind,
    title: `${kind} title`,
    content: undefined,
  };
}

function wrap(element: ReactElement): ReactElement {
  return <I18nProvider>{element}</I18nProvider>;
}

let browserSnapshot: ReturnType<typeof installBrowser>;
let renderers: ReactTestRenderer[] = [];

beforeEach(() => {
  browserSnapshot = installBrowser();
});

afterEach(async () => {
  for (const renderer of renderers.splice(0)) await fire(() => renderer.unmount());
  restoreBrowser(browserSnapshot);
});

async function loaded(element: ReactElement): Promise<ReactTestRenderer> {
  const renderer = await renderRenderer(wrap(element));
  await flushRenderer();
  renderers.push(renderer);
  return renderer;
}

describe("AssetEditorDialog renderer interactions", () => {
  test("loads text values, splits tags, saves trimmed values, and dismisses on Escape", async () => {
    const saved: AssetEditorValues[] = [];
    let closeCount = 0;
    const renderer = await loaded(<AssetEditorDialog
      asset={textAsset}
      onClose={() => { closeCount += 1; }}
      onSave={async (values) => { saved.push(values); }}
    />);
    expect(nodeText(renderer.root)).toContain("编辑素材");
    const title = hostInput(renderer, (node) => node.props.id === "asset-title");
    const source = hostInput(renderer, (node) => node.props["aria-label"] === "来源");
    const tags = hostInput(renderer, (node) => node.props.value === "one, two");
    const notes = hostNodes(renderer, "textarea").find((node) => node.props.value === "old notes")!;
    const content = hostNodes(renderer, "textarea").find((node) => node.props.value === "old content")!;
    await fire(() => title.props.onChange({ target: { value: "  New title  " } }));
    await fire(() => source.props.onChange({ target: { value: "  new source " } }));
    await fire(() => tags.props.onChange({ target: { value: " alpha, beta， gamma ,, " } }));
    await fire(() => notes.props.onChange({ target: { value: " new notes " } }));
    await fire(() => content.props.onChange({ target: { value: "new content" } }));

    await fire(() => hostNodes(renderer, "form")[0]!.props.onSubmit({ preventDefault: () => undefined }));
    await flushRenderer();
    expect(saved).toEqual([{
      title: "New title",
      tags: ["alpha", "beta", "gamma"],
      source: "new source",
      notes: "new notes",
      content: "new content",
      replacement: undefined,
    }]);

    const keydown = { type: "keydown", key: "Escape", preventDefault: () => undefined, stopImmediatePropagation: () => undefined };
    (globalThis.window as unknown as { dispatchEvent: (event: unknown) => boolean }).dispatchEvent(keydown);
    expect(closeCount).toBe(1);
    const closeButton = hostNodes(renderer, "button").find((node) => node.props.title === "关闭素材编辑器")!;
    await fire(() => closeButton.props.onClick());
    expect(closeCount).toBe(2);
  });

  test("renders replacement inputs for image, video, and audio assets", async () => {
    for (const kind of ["image", "video", "audio"] as const) {
      let values: AssetEditorValues | undefined;
      const renderer = await loaded(<AssetEditorDialog
        asset={mediaAsset(kind)}
        mode="create"
        onClose={() => undefined}
        onSave={async (next) => { values = next; }}
      />);
      expect(nodeText(renderer.root)).toContain(kind === "image" ? "替换图片" : kind === "video" ? "替换视频" : "替换音频");
      const title = hostInput(renderer, (node) => node.props.id === "asset-title");
      await fire(() => title.props.onChange({ target: { value: `${kind} replacement` } }));
      const file = new File([`${kind}-bytes`], `${kind}.bin`, { type: `${kind}/test` });
      const fileInput = hostInput(renderer, (node) => node.props.type === "file");
      await fire(() => fileInput.props.onChange({ target: { files: [file] } }));
      await fire(() => hostNodes(renderer, "form")[0]!.props.onSubmit({ preventDefault: () => undefined }));
      await flushRenderer();
      expect(values?.replacement).toBe(file);
      expect(values?.title).toBe(`${kind} replacement`);
      await fire(() => renderer.unmount());
      renderers = renderers.filter((candidate) => candidate !== renderer);
    }
  });

  test("surfaces save failures and ignores blank titles", async () => {
    let saveCalls = 0;
    const renderer = await loaded(<AssetEditorDialog
      asset={textAsset}
      onClose={() => undefined}
      onSave={async () => { saveCalls += 1; throw new Error("save failed"); }}
    />);
    const title = hostInput(renderer, (node) => node.props.id === "asset-title");
    await fire(() => title.props.onChange({ target: { value: "  " } }));
    const submit = hostButton(renderer, "保存");
    expect(submit.props.disabled).toBe(true);
    await fire(() => hostNodes(renderer, "form")[0]!.props.onSubmit({ preventDefault: () => undefined }));
    expect(saveCalls).toBe(0);
    await fire(() => title.props.onChange({ target: { value: "valid" } }));
    await fire(() => hostNodes(renderer, "form")[0]!.props.onSubmit({ preventDefault: () => undefined }));
    await flushRenderer();
    expect(saveCalls).toBe(1);
    expect(nodeText(renderer.root)).toContain("save failed");
  });

  test("returns null when no asset is selected", async () => {
    const renderer = await loaded(<AssetEditorDialog asset={null} onClose={() => undefined} onSave={async () => undefined} />);
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
  });
});
