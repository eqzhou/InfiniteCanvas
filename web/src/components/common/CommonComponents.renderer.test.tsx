import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { I18nProvider } from "@/i18n/I18nProvider";
import { installBrowser, flushRenderer, fire, hostButton, hostNodes, nodeText, renderRenderer, restoreBrowser } from "@/test/react-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { ConfirmDialog } from "./ConfirmDialog";
import { MediaView } from "./MediaView";
import { ToastContainer } from "./ToastContainer";
import { dismissToast, showToast, subscribeToasts, toast } from "./toast";

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

describe("MediaView renderer branches", () => {
  test("uses preview images and falls back to the full source after an error", async () => {
    const renderer = await loaded(<MediaView kind="image" src="full.png" previewSrc="preview.png" alt="Preview" />);
    let image = hostNodes(renderer, "img")[0]!;
    expect(image.props.src).toBe("preview.png");
    await fire(() => image.props.onError());
    image = hostNodes(renderer, "img")[0]!;
    expect(image.props.src).toBe("full.png");
    await fire(() => image.props.onClick?.());
  });

  test("renders controlled video, poster preview, plain video, and null branches", async () => {
    const controlled = await loaded(<MediaView kind="video" src="movie.mp4" previewSrc="poster.jpg" alt="Movie" controls autoPlay muted={false} />);
    const video = hostNodes(controlled, "video")[0]!;
    expect(video.props.controls).toBe(true);
    expect(video.props.poster).toBe("poster.jpg");
    expect(video.props.autoPlay).toBe(true);
    expect(video.props.preload).toBe("auto");

    const preview = await loaded(<MediaView kind="video" src="movie.mp4" previewSrc="poster.jpg" alt="Poster" onActivate={() => undefined} />);
    expect(hostNodes(preview, "img")[0]!.props.src).toBe("poster.jpg");
    await fire(() => hostNodes(preview, "img")[0]!.props.onError());
    await flushRenderer();
    expect(hostNodes(preview, "video")[0]!.props.src).toBe("movie.mp4");

    const plain = await loaded(<MediaView kind="video" src="movie.mp4" alt="Plain" muted={false} />);
    expect(hostNodes(plain, "video")[0]!.props.muted).toBe(false);
    const empty = await loaded(<MediaView kind="video" alt="Empty" />);
    expect(empty.root.findAllByType("video")).toHaveLength(0);
    expect(empty.root.findAllByType("img")).toHaveLength(0);
  });

  test("returns null for an image without either source", async () => {
    const renderer = await loaded(<MediaView kind="image" alt="Nothing" />);
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
  });
});

describe("ConfirmDialog focus and dismissal handlers", () => {
  test("confirms, cancels, handles Escape/backdrop, and traps Tab", async () => {
    let cancelled = 0;
    let confirmed = 0;
    const renderer = await loaded(<ConfirmDialog
      title="Delete item"
      message="This cannot be undone"
      confirmLabel="Delete"
      onCancel={() => { cancelled += 1; }}
      onConfirm={() => { confirmed += 1; }}
    />);
    const dialog = hostNodes(renderer, "div").find((node) => node.props.role === "alertdialog")!;
    expect(nodeText(dialog)).toContain("This cannot be undone");
    const buttons = hostNodes(renderer, "button");
    expect(buttons).toHaveLength(2);
    await fire(() => buttons[0]!.props.onClick());
    await fire(() => buttons[1]!.props.onClick());
    expect(cancelled).toBe(1);
    expect(confirmed).toBe(1);

    const escape = { key: "Escape", preventDefault: () => undefined };
    await fire(() => dialog.props.onKeyDown({ ...escape, currentTarget: { querySelectorAll: () => buttons } }));
    expect(cancelled).toBe(2);
    const backdrop = hostNodes(renderer, "div").find((node) => node.props.className?.includes("ob-overlay"))!;
    await fire(() => backdrop.props.onClick({ target: backdrop, currentTarget: backdrop }));
    expect(cancelled).toBe(3);

    const focusable = [
      { focus: () => { (globalThis.document as unknown as { activeElement: unknown }).activeElement = "first"; } },
      { focus: () => { (globalThis.document as unknown as { activeElement: unknown }).activeElement = "last"; } },
    ];
    (globalThis.document as unknown as { activeElement: unknown }).activeElement = focusable[0];
    await fire(() => dialog.props.onKeyDown({
      key: "Tab",
      shiftKey: true,
      currentTarget: { querySelectorAll: () => focusable },
      preventDefault: () => undefined,
    }));
    (globalThis.document as unknown as { activeElement: unknown }).activeElement = focusable[1];
    await fire(() => dialog.props.onKeyDown({
      key: "Tab",
      shiftKey: false,
      currentTarget: { querySelectorAll: () => focusable },
      preventDefault: () => undefined,
    }));
  });

  test("uses neutral tone and suppresses dismissal while busy", async () => {
    let cancelled = 0;
    const renderer = await loaded(<ConfirmDialog
      title="Working"
      confirmLabel="Continue"
      tone="neutral"
      busy
      onCancel={() => { cancelled += 1; }}
      onConfirm={() => undefined}
    />);
    const dialog = hostNodes(renderer, "div").find((node) => node.props.role === "alertdialog")!;
    const backdrop = hostNodes(renderer, "div").find((node) => node.props.className?.includes("ob-overlay"))!;
    await fire(() => dialog.props.onKeyDown({ key: "Escape", preventDefault: () => undefined, currentTarget: { querySelectorAll: () => [] } }));
    await fire(() => backdrop.props.onClick({ target: backdrop, currentTarget: backdrop }));
    expect(cancelled).toBe(0);
    expect(hostNodes(renderer, "button").every((button) => button.props.disabled)).toBe(true);
    expect(nodeText(renderer.root)).toContain("处理中");
  });
});

describe("ToastContainer and toast store", () => {
  test("renders every tone, caps visible items, and dismisses a toast", async () => {
    const renderer = await loaded(<ToastContainer />);
    const ids = [
      showToast("neutral", "neutral", 0),
      toast.success("success", 0),
      toast.error("danger", 0),
      toast.warn("warning", 0),
      toast.info("info", 0),
      showToast("oldest", "neutral", 0),
    ];
    await flushRenderer();
    expect(hostNodes(renderer, "div").filter((node) => node.props.role === "alert")).toHaveLength(5);
    expect(nodeText(renderer.root)).toContain("oldest");
    const close = hostNodes(renderer, "button").find((node) => node.props["aria-label"] === "关闭")!;
    await fire(() => close.props.onClick());
    expect(hostNodes(renderer, "div").filter((node) => node.props.role === "alert")).toHaveLength(4);
    ids.forEach(dismissToast);
    await flushRenderer();
    expect(renderer.root.findAll((node) => node.props.role === "alert")).toHaveLength(0);
  });

  test("notifies subscribers immediately and on updates, then unsubscribes", () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeToasts((items) => snapshots.push(items.map((item) => item.message)));
    const id = showToast("subscribed", "neutral", 0);
    expect(snapshots.at(-1)).toContain("subscribed");
    unsubscribe();
    dismissToast(id);
    expect(snapshots.at(-1)).toContain("subscribed");
  });
});
