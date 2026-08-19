import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import { I18nProvider } from "@/i18n/I18nProvider";
import { createDefaultCameraPrompt } from "@/lib/camera-prompt";
import { createDefaultConfig, createNode, createProject } from "@/lib/defaults";
import type { BoardNode, CameraPromptConfig, PluginManifest, PromptItem } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import {
  fire,
  flushRenderer,
  hostButton,
  hostInput,
  hostNodes,
  hostSelect,
  installBrowser,
  nodeText,
  renderRenderer,
  restoreBrowser,
} from "@/test/react-renderer";
import { AngleDialog } from "./AngleDialog";
import { AudioNodePlayer } from "./AudioNodePlayer";
import { CameraPromptPanel } from "./CameraPromptPanel";
import { ContextMenu } from "./ContextMenu";
import { CropDialog } from "./CropDialog";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import { ProjectAudioRolesDialog } from "./ProjectAudioRolesDialog";
import { PromptChipInput } from "./PromptChipInput";

type BrowserSnapshot = ReturnType<typeof installBrowser>;

const activeRenderers: ReactTestRenderer[] = [];
const browserSnapshots: BrowserSnapshot[] = [];
const imageSnapshots: Array<{ had: boolean; value: unknown }> = [];
const fetchSnapshots: Array<typeof fetch> = [];
const storeSnapshots: Array<ReturnType<typeof useBoardStore.getState>> = [];

function withI18n(element: ReactElement): ReactElement {
  return <I18nProvider>{element}</I18nProvider>;
}

function startBrowser(): void {
  const snapshot = installBrowser();
  browserSnapshots.push(snapshot);
  // ReactDOM.createPortal validates a DOM container. React test renderer only
  // needs a mutable children array, so keep this surface local to the test.
  Object.assign(document.body as object, { nodeType: 1, children: [], createNodeMock: () => null });
  const browserWindow = window as unknown as {
    requestAnimationFrame?: typeof requestAnimationFrame;
    cancelAnimationFrame?: typeof cancelAnimationFrame;
  };
  browserWindow.requestAnimationFrame = globalThis.requestAnimationFrame;
  browserWindow.cancelAnimationFrame = globalThis.cancelAnimationFrame;
}

function saveStore(): void {
  storeSnapshots.push(useBoardStore.getState());
}

function seedStore(projects = [createProject("Dialog test")]): void {
  saveStore();
  useBoardStore.setState({
    ready: true,
    projectsState: "loaded",
    assetsState: "loaded",
    promptsState: "loaded",
    projectsError: null,
    assetsError: null,
    promptsError: null,
    projects,
    activeProjectId: projects[0]?.id ?? null,
    selectedIds: [],
    config: createDefaultConfig(),
    assets: [],
    prompts: [],
    imageRetryRequestId: null,
    persist: async () => undefined,
    persistNow: async () => undefined,
  });
}

async function loaded(element: ReactElement): Promise<ReactTestRenderer> {
  const renderer = await renderRenderer(withI18n(element));
  activeRenderers.push(renderer);
  await flushRenderer();
  return renderer;
}

function hostByClass(renderer: ReactTestRenderer, fragment: string): ReactTestInstance {
  const result = hostNodes(renderer, "div").find((node) => String(node.props.className ?? "").includes(fragment));
  if (!result) throw new Error(`host div not found: ${fragment}`);
  return result;
}

function hostAria(renderer: ReactTestRenderer, aria: string): ReactTestInstance {
  const result = hostNodes(renderer, "button").find((node) => node.props["aria-label"] === aria);
  if (!result) throw new Error(`button aria label not found: ${aria}`);
  return result;
}

function hostTitle(renderer: ReactTestRenderer, title: string): ReactTestInstance {
  const result = hostNodes(renderer, "button").find((node) => node.props.title === title);
  if (!result) throw new Error(`button title not found: ${title}`);
  return result;
}

function hostExactButton(renderer: ReactTestRenderer, text: string): ReactTestInstance {
  const result = hostNodes(renderer, "button").find((node) => nodeText(node) === text);
  if (!result) throw new Error(`exact button not found: ${text}`);
  return result;
}

function event(overrides: Record<string, unknown> = {}): never {
  return {
    key: "",
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    stopImmediatePropagation: () => undefined,
    target: {},
    currentTarget: {},
    nativeEvent: { isComposing: false },
    ...overrides,
  } as never;
}

function installImageMock(): void {
  const had = "Image" in globalThis;
  imageSnapshots.push({ had, value: (globalThis as Record<string, unknown>).Image });
  class TestImage {
    naturalWidth = 800;
    naturalHeight = 600;
    onload: (() => void) | null = null;
    set src(_value: string) {
      this.onload?.();
    }
  }
  (globalThis as Record<string, unknown>).Image = TestImage;
}

function installFetch404(): void {
  fetchSnapshots.push(globalThis.fetch);
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
}

afterEach(async () => {
  for (const renderer of activeRenderers.splice(0)) await fire(() => renderer.unmount());
  while (fetchSnapshots.length) globalThis.fetch = fetchSnapshots.pop()!;
  while (imageSnapshots.length) {
    const snapshot = imageSnapshots.pop()!;
    if (snapshot.had) (globalThis as Record<string, unknown>).Image = snapshot.value;
    else delete (globalThis as Record<string, unknown>).Image;
  }
  while (storeSnapshots.length) await fire(() => useBoardStore.setState(storeSnapshots.pop()!, true));
  while (browserSnapshots.length) restoreBrowser(browserSnapshots.pop()!);
});

describe("canvas dialogs and media controls with the React renderer", () => {
  test("drives angle presets, numeric input, confirmation and dismissal", async () => {
    startBrowser();
    const node = createNode("image", { x: 12, y: 18 }, { metadata: { content: "data:image/png;base64,AA==" } });
    let closed = 0;
    let confirmed: number | undefined;
    const renderer = await loaded(
      <AngleDialog
        node={node}
        open
        onClose={() => { closed += 1; }}
        onConfirm={(degrees) => { confirmed = degrees; }}
      />,
    );
    const degreeInput = hostInput(renderer, (candidate) => candidate.props.type === "number");
    await fire(() => degreeInput.props.onChange({ target: { value: "45" } }));
    await fire(() => hostButton(renderer, "90°").props.onClick());
    expect(degreeInput.props.value).toBe(90);
    await fire(() => hostButton(renderer, "生成变换节点").props.onClick());
    expect(confirmed).toBe(90);
    await fire(() => hostButton(renderer, "取消").props.onClick());
    await fire(() => hostAria(renderer, "关闭角度对话框").props.onClick());
    expect(closed).toBe(2);

    const closedRenderer = await loaded(
      <AngleDialog node={node} open={false} onClose={() => undefined} onConfirm={() => undefined} />,
    );
    expect(closedRenderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  test("updates camera prompt controls and exercises responsive lifecycle cleanup", async () => {
    startBrowser();
    let changed: CameraPromptConfig | undefined;
    let closed = 0;
    const anchor = {
      getBoundingClientRect: () => ({ left: 100, top: 220, right: 140, bottom: 250, width: 40, height: 30 }),
      parentElement: null,
      contains: () => false,
    } as unknown as HTMLElement;
    const value = createDefaultCameraPrompt();
    const renderer = await loaded(
      <CameraPromptPanel
        value={value}
        anchor={anchor}
        onChange={(next) => { changed = next; }}
        onClose={() => { closed += 1; }}
      />,
    );
    await fire(() => hostInput(renderer, (candidate) => candidate.props.type === "checkbox").props.onChange({ target: { checked: true } }));
    expect(changed).toMatchObject({ enabled: true });
    await fire(() => hostSelect(renderer, (candidate) => candidate.props.value === "cinema").props.onChange({ target: { value: "drone" } }));
    expect(changed).toMatchObject({ camera: "drone" });
    const numberInputs = hostNodes(renderer, "input").filter((candidate) => candidate.props.type === "number");
    await fire(() => numberInputs[0]!.props.onChange({ target: { value: "999" } }));
    expect(changed).toMatchObject({ focalLength: 600 });
    await fire(() => numberInputs[1]!.props.onChange({ target: { value: "0.1" } }));
    expect(changed).toMatchObject({ aperture: 0.7 });
    await fire(() => hostTitle(renderer, "关闭摄像机设置").props.onClick());
    expect(closed).toBe(1);
    await fire(() => renderer.unmount());
    activeRenderers.splice(activeRenderers.indexOf(renderer), 1);
  });

  test("covers canvas and node context-menu actions, plugins and file upload errors", async () => {
    startBrowser();
    const calls: string[] = [];
    const point = { x: 33, y: 44 };
    const plugins: PluginManifest[] = [{ id: "plug", name: "Plugin", version: "1", entry: "https://example.test/plugin.js" }];
    const renderer = await loaded(
      <ContextMenu
        state={{ screen: { x: 120, y: 140 }, world: point }}
        onClose={() => calls.push("close")}
        onAdd={(type, at, pluginId) => calls.push(`${type}:${at.x}:${pluginId ?? ""}`)}
        onPaste={(at) => calls.push(`paste:${at.x}`)}
        onUploadMedia={async () => { throw new Error("upload failed"); }}
        onOpenAssets={(at) => calls.push(`assets:${at.y}`)}
        plugins={plugins}
      />,
    );
    for (const label of ["粘贴", "从素材库插入", "新建文本", "新建图片", "新建配置", "新建视频", "新建音频", "新建全景", "新建导演台", "插件 · Plugin"]) {
      await fire(() => hostButton(renderer, label).props.onClick());
    }
    const upload = hostButton(renderer, "上传资源到画布");
    await fire(() => upload.props.onClick());
    const fileInput = hostInput(renderer, (candidate) => candidate.props.type === "file");
    await fire(() => fileInput.props.onChange({ target: { files: [new File(["x"], "x.png", { type: "image/png" })] }, currentTarget: { value: "chosen" } }));
    expect(calls).toContain("paste:33");
    expect(calls).toContain("plugin:33:plug");

    const nodeCalls: string[] = [];
    const nodeRenderer = await loaded(
      <ContextMenu
        state={{ screen: { x: 1270, y: 790 }, world: point, nodeId: "node" }}
        multi
        canGroup
        canUngroup
        onClose={() => nodeCalls.push("close")}
        onAdd={() => nodeCalls.push("add")}
        onPaste={() => nodeCalls.push("paste")}
        onDelete={() => nodeCalls.push("delete")}
        onDuplicate={() => nodeCalls.push("duplicate")}
        onBring={() => nodeCalls.push("bring")}
        onAlign={(mode) => nodeCalls.push(`align:${mode}`)}
        onDistribute={(axis) => nodeCalls.push(`distribute:${axis}`)}
        onGroup={() => nodeCalls.push("group")}
        onUngroup={() => nodeCalls.push("ungroup")}
      />,
    );
    for (const label of ["取消组合", "组合", "创建副本", "删除", "适应视图", "左对齐", "右对齐", "顶对齐", "底对齐", "水平居中", "垂直居中", "水平分布", "垂直分布"]) {
      await fire(() => hostExactButton(nodeRenderer, label).props.onClick());
    }
    expect(nodeCalls).toEqual(expect.arrayContaining(["group", "ungroup", "duplicate", "delete", "bring", "align:left", "align:right", "align:top", "align:bottom", "align:hcenter", "align:vcenter", "distribute:x", "distribute:y"]));
  });

  test("confirms crop values after image metadata loads and handles empty image state", async () => {
    startBrowser();
    installImageMock();
    const node = createNode("image", { x: 0, y: 0 }, { metadata: { content: "data:image/png;base64,AA==" } });
    let crop: { x: number; y: number; w: number; h: number } | undefined;
    let closed = 0;
    const renderer = await loaded(<CropDialog node={node} open onClose={() => { closed += 1; }} onConfirm={(value) => { crop = value; }} />);
    const inputs = hostNodes(renderer, "input").filter((candidate) => candidate.props.type === "number");
    await fire(() => inputs[0]!.props.onChange({ target: { value: "-5" } }));
    await fire(() => inputs[1]!.props.onChange({ target: { value: "-6" } }));
    await fire(() => inputs[2]!.props.onChange({ target: { value: "0" } }));
    await fire(() => inputs[3]!.props.onChange({ target: { value: "30" } }));
    await fire(() => hostButton(renderer, "生成裁剪节点").props.onClick());
    expect(crop).toEqual({ x: 0, y: 0, w: 1, h: 30 });
    await fire(() => hostButton(renderer, "取消").props.onClick());
    await fire(() => hostAria(renderer, "关闭裁剪").props.onClick());
    expect(closed).toBe(2);
    const emptyRenderer = await loaded(<CropDialog node={createNode("image", { x: 0, y: 0 })} open onClose={() => undefined} onConfirm={() => undefined} />);
    expect(nodeText(emptyRenderer.root)).toContain("裁剪图片");
  });

  test("zooms, drags, resets and closes image previews, including video branch", async () => {
    startBrowser();
    let closed = 0;
    const renderer = await loaded(<ImagePreviewDialog open src="/image.png" alt="Preview" onClose={() => { closed += 1; }} />);
    const zoomIn = hostAria(renderer, "放大图片");
    const zoomOut = hostAria(renderer, "缩小图片");
    await fire(() => zoomIn.props.onClick());
    expect(nodeText(renderer.root)).toContain("125%");
    const canvas = hostByClass(renderer, "relative grid");
    const capture = { setPointerCapture: () => undefined };
    await fire(() => canvas.props.onPointerDown(event({ button: 0, pointerId: 1, clientX: 10, clientY: 20, currentTarget: capture })));
    await fire(() => canvas.props.onPointerMove(event({ pointerId: 1, clientX: 30, clientY: 50 })));
    await fire(() => canvas.props.onPointerUp(event({ pointerId: 1 })));
    await fire(() => canvas.props.onDoubleClick(event()));
    await fire(() => hostAria(renderer, "重置缩放").props.onClick());
    await fire(() => zoomOut.props.onClick());
    const overlay = renderer.root.findByProps({ role: "dialog" });
    const sameTarget = {};
    await fire(() => overlay.props.onPointerDown(event({ target: sameTarget, currentTarget: sameTarget })));
    expect(closed).toBe(1);
    const videoRenderer = await loaded(<ImagePreviewDialog open src="/video.mp4" alt="Video" video onClose={() => { closed += 1; }} />);
    expect(videoRenderer.root.findAllByType("video")).toHaveLength(1);
    expect(videoRenderer.root.findAllByProps({ "aria-label": "放大图片" })).toHaveLength(0);
    await fire(() => hostAria(videoRenderer, "关闭预览").props.onClick());
    expect(closed).toBe(2);
  });

  test("edits project audio roles through the real store update path", async () => {
    startBrowser();
    installFetch404();
    const project = createProject("Audio cast");
    seedStore([project]);
    const renderer = await loaded(<ProjectAudioRolesDialog open onClose={() => undefined} />);
    expect(nodeText(renderer.root)).toContain("Audio cast");
    await fire(() => hostButton(renderer, "添加角色").props.onClick());
    await flushRenderer();
    const roleInput = hostInput(renderer, (candidate) => String(candidate.props["aria-label"] ?? "").includes("角色名称"));
    await fire(() => roleInput.props.onChange({ target: { value: " Narrator " } }));
    await fire(() => roleInput.props.onBlur());
    const voice = hostSelect(renderer, (candidate) => String(candidate.props["aria-label"] ?? "").includes("声线"));
    await fire(() => voice.props.onChange({ target: { value: String(voice.props.value) } }));
    const remove = hostNodes(renderer, "button").find((candidate) => String(candidate.props["aria-label"] ?? "").includes("删除角色"));
    expect(remove).toBeDefined();
    await fire(() => remove!.props.onClick());
    expect(useBoardStore.getState().getActive()?.audioRoles).toEqual([]);
    const closedRenderer = await loaded(<ProjectAudioRolesDialog open={false} onClose={() => undefined} />);
    expect(closedRenderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  test("handles prompt editor composition, submit shortcut and safe empty callbacks", async () => {
    startBrowser();
    let changed = 0;
    let submitted = 0;
    const references = [
      { nodeId: "image-1", kind: "image" as const, label: "图片1", title: "Reference image", content: "data:image/png;base64,AA==" },
      { nodeId: "audio-1", kind: "audio" as const, label: "音频1", title: "Reference audio" },
    ];
    const renderer = await loaded(
      <PromptChipInput
        value=""
        references={references}
        placeholder="提示词"
        onChange={() => { changed += 1; }}
        onSubmit={() => { submitted += 1; }}
      />,
    );
    const editor = renderer.root.findByProps({ role: "textbox" });
    await fire(() => editor.props.onCompositionStart());
    await fire(() => editor.props.onKeyDown(event({ key: "Enter", ctrlKey: true })));
    expect(submitted).toBe(0);
    await fire(() => editor.props.onCompositionEnd());
    await fire(() => editor.props.onKeyDown(event({ key: "Enter", ctrlKey: true })));
    expect(submitted).toBe(1);
    await fire(() => editor.props.onPaste(event({ clipboardData: { getData: () => "pasted" } })));
    await fire(() => editor.props.onInput());
    await fire(() => editor.props.onBlur());
    expect(changed).toBe(0);
  });

  test("runs audio element event handlers and mute/progress controls safely", async () => {
    startBrowser();
    const renderer = await loaded(<AudioNodePlayer src="/audio.mp3" />);
    const audio = renderer.root.findByType("audio");
    await fire(() => audio.props.onLoadedMetadata());
    await fire(() => audio.props.onDurationChange());
    await fire(() => audio.props.onTimeUpdate());
    await fire(() => audio.props.onPlay());
    await flushRenderer();
    await fire(() => audio.props.onPause());
    await fire(() => audio.props.onEnded());
    const progress = hostInput(renderer, (candidate) => candidate.props.type === "range");
    await fire(() => progress.props.onChange({ target: { value: "50" } }));
    const play = hostAria(renderer, "播放音频");
    await fire(() => play.props.onClick());
    const mute = hostAria(renderer, "静音");
    await fire(() => mute.props.onClick());
    expect(hostAria(renderer, "取消静音")).toBeDefined();
  });
});
