import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { BoardNode } from "@/types/board";
import { createDefaultConfig, createNode, createProject } from "@/lib/defaults";
import { useBoardStore } from "@/stores/use-board-store";
import { NodeActions, nodeVideoControls } from "@/components/canvas/NodeActions";
import { NodePromptBar } from "@/components/canvas/NodePromptBar";
import { BoardNodeView, moveInput } from "@/components/canvas/BoardNodeView";
import { BoardCanvas, backgroundStyle } from "@/components/canvas/BoardCanvas";

type Listener = (...args: unknown[]) => void;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  isConnected = true;
  tagName = "DIV";
  value = "";
  files: File[] = [];
  click(): void { /* test-only anchor/input surface */ }
  focus(): void { /* test-only focus surface */ }
  contains(_value: unknown): boolean { return false; }
  closest(_selector: string): FakeElement | null { return null; }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  }
  setPointerCapture(_pointerId: number): void { /* test-only pointer surface */ }
  releasePointerCapture(_pointerId: number): void { /* test-only pointer surface */ }
  hasPointerCapture(_pointerId: number): boolean { return false; }
  addEventListener(_type: string, _listener: Listener, _options?: unknown): void { /* test-only event surface */ }
  removeEventListener(_type: string, _listener: Listener, _options?: unknown): void { /* test-only event surface */ }
  querySelector<T extends FakeElement>(_selector: string): T | null { return null; }
  querySelectorAll<T extends FakeElement>(_selector: string): T[] { return []; }
}

class FakeResizeObserver {
  constructor(_callback: () => void) {}
  observe(_target: unknown): void {}
  disconnect(): void {}
}

class FakeMutationObserver {
  constructor(_callback: () => void) {}
  observe(_target: unknown, _options?: unknown): void {}
  disconnect(): void {}
}

type GlobalSnapshot = {
  document: typeof globalThis.document;
  window: typeof globalThis.window;
  element: typeof globalThis.Element;
  htmlElement: typeof globalThis.HTMLElement;
  resizeObserver: typeof globalThis.ResizeObserver;
  mutationObserver: typeof globalThis.MutationObserver;
  requestAnimationFrame: typeof globalThis.requestAnimationFrame;
  cancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  fetch: typeof globalThis.fetch;
};

const globalSnapshots: Array<{ snapshot: GlobalSnapshot; restore: () => void }> = [];

function installBrowserGlobals(): { listeners: Map<string, Listener[]>; restore: () => void } {
  const snapshot: GlobalSnapshot = {
    document: globalThis.document,
    window: globalThis.window,
    element: globalThis.Element,
    htmlElement: globalThis.HTMLElement,
    resizeObserver: globalThis.ResizeObserver,
    mutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    fetch: globalThis.fetch,
  };
  const restoreSnapshot = () => {
    globalThis.document = snapshot.document;
    globalThis.window = snapshot.window;
    globalThis.Element = snapshot.element;
    globalThis.HTMLElement = snapshot.htmlElement;
    globalThis.ResizeObserver = snapshot.resizeObserver;
    globalThis.MutationObserver = snapshot.mutationObserver;
    globalThis.requestAnimationFrame = snapshot.requestAnimationFrame;
    globalThis.cancelAnimationFrame = snapshot.cancelAnimationFrame;
    globalThis.fetch = snapshot.fetch;
  };
  globalSnapshots.push({
    snapshot,
    restore: () => {
      restoreSnapshot();
      globalSnapshots.pop();
    },
  });

  const listeners = new Map<string, Listener[]>();
  const addListener = (type: string, listener: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  };
  const removeListener = (type: string, listener: Listener) => {
    listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  };
  const body = new FakeElement();
  body.tagName = "BODY";
  const documentMock = {
    body,
    activeElement: null,
    querySelector: <T extends FakeElement>(_selector: string): T | null => null,
    addEventListener: addListener,
    removeEventListener: removeListener,
    createElement: (tag: string) => {
      const element = new FakeElement();
      element.tagName = tag.toUpperCase();
      return element;
    },
  } as unknown as typeof globalThis.document;
  const visualViewport = {
    addEventListener: addListener,
    removeEventListener: removeListener,
  };
  const windowMock = {
    innerWidth: 1280,
    innerHeight: 800,
    visualViewport,
    addEventListener: addListener,
    removeEventListener: removeListener,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  } as unknown as typeof globalThis.window;
  globalThis.document = documentMock;
  globalThis.window = windowMock;
  globalThis.Element = FakeElement as unknown as typeof globalThis.Element;
  globalThis.HTMLElement = FakeElement as unknown as typeof globalThis.HTMLElement;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof globalThis.ResizeObserver;
  globalThis.MutationObserver = FakeMutationObserver as unknown as typeof globalThis.MutationObserver;
  globalThis.requestAnimationFrame = windowMock.requestAnimationFrame;
  globalThis.cancelAnimationFrame = windowMock.cancelAnimationFrame;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/shared-channels") || url.endsWith("/media-capabilities") || url.endsWith("/auth/site-policy")) {
      return new Response(null, { status: 404 });
    }
    if (url.includes("/projects/") && init.method === "PUT") {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;

  return {
    listeners,
    restore: () => {
      restoreSnapshot();
      globalSnapshots.pop();
    },
  };
}

function channelConfig(withKeys = false) {
  const defaults = createDefaultConfig();
  const source = defaults.channels[0]!;
  const channel = structuredClone(source);
  if (withKeys) {
    channel.apiKey = "test-key";
    for (const provider of Object.values(channel.providers)) provider.apiKey = "test-key";
  }
  return { ...defaults, channels: [channel], activeChannelId: channel.id };
}

function seedProject(nodes: BoardNode[] = [], withKeys = false) {
  const project = createProject("Canvas component test");
  project.nodes = nodes;
  const config = channelConfig(withKeys);
  useBoardStore.setState({
    ready: true,
    projectsState: "loaded",
    assetsState: "loaded",
    promptsState: "loaded",
    projectsError: null,
    assetsError: null,
    promptsError: null,
    projects: [project],
    activeProjectId: project.id,
    selectedIds: [],
    connectingFrom: null,
    config,
    assets: [],
    prompts: [],
    imageRetryRequestId: null,
    showMinimap: true,
  });
  return { project, config, channel: config.channels[0]! };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function instancesByType(renderer: ReactTestRenderer, type: string): ReactTestInstance[] {
  return renderer.root.findAll((instance) => instance.type === type);
}

function findButton(renderer: ReactTestRenderer, predicate: (instance: ReactTestInstance) => boolean): ReactTestInstance {
  const button = instancesByType(renderer, "button").find(predicate);
  if (!button) throw new Error("test button not found");
  return button;
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    target: new FakeElement(),
    currentTarget: new FakeElement(),
    ...overrides,
  } as never;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

afterEach(async () => {
  await settle();
  while (globalSnapshots.length) globalSnapshots.at(-1)!.restore();
});

describe("canvas component rendering and interaction coverage", () => {
  test("covers pure canvas helper boundaries", () => {
    const { channel } = seedProject();
    const video = createNode("video", { x: 0, y: 0 }, {
      metadata: { model: "custom-video", videoRatio: "9:16", resolution: "1080p", duration: 8 },
    });
    expect(nodeVideoControls(video, channel)).toMatchObject({ seconds: 8, ratio: "9:16", resolution: "1080p" });
    expect(moveInput(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveInput(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveInput(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(backgroundStyle("blank", { x: 0, y: 0, k: 1 })).toEqual({});
    expect(backgroundStyle("dots", { x: 4, y: 8, k: 2 })).toMatchObject({ backgroundSize: "48px 48px" });
    expect(backgroundStyle("lines", { x: 4, y: 8, k: 2 }).backgroundImage).toContain("linear-gradient");
  });

  test("renders NodeActions for text and updates text/font/config state", () => {
    const browser = installBrowserGlobals();
    const node = createNode("text", { x: 10, y: 20 }, { id: "text-actions", metadata: { content: "draft", fontSize: 20 } });
    seedProject([node]);
    const renderer = render(<NodeActions node={node} />);

    act(() => {
      findButton(renderer, (item) => item.props.title === "减小字号").props.onClick();
      findButton(renderer, (item) => item.props.title === "增大字号").props.onClick();
    });
    expect(useBoardStore.getState().getActive()?.nodes[0]?.metadata.fontSize).toBe(22);

    act(() => {
      findButton(renderer, (item) => item.props.title === "生图").props.onClick();
    });
    const project = useBoardStore.getState().getActive()!;
    expect(project.nodes.some((candidate) => candidate.type === "config")).toBe(true);
    expect(project.edges.some((edge) => edge.from === node.id)).toBe(true);
    expect(browser.listeners.get("keydown")?.length ?? 0).toBe(0);
    renderer.unmount();
  });

  test("renders image, video, audio, and config action branches", () => {
    const browser = installBrowserGlobals();
    const cases: BoardNode[] = [
      createNode("image", { x: 0, y: 0 }, { id: "image-actions", metadata: { status: "error", errorDetails: "offline" } }),
      createNode("video", { x: 0, y: 0 }, { id: "video-actions", metadata: { status: "error", errorDetails: "offline" } }),
      createNode("audio", { x: 0, y: 0 }, { id: "audio-actions", metadata: { status: "error", errorDetails: "offline" } }),
      createNode("config", { x: 0, y: 0 }, { id: "config-actions", metadata: { generationMode: "image", status: "idle" } }),
    ];
    seedProject(cases);
    for (const node of cases) {
      const renderer = render(<NodeActions node={node} inlineConfigOnly={node.type === "config"} />);
      expect(renderer.root.findAll((item) => item.type === "button").length).toBeGreaterThan(0);
      const safeAction = node.type === "image"
        ? "反推提示词"
        : node.type === "video"
          ? "生成视频"
          : node.type === "audio"
            ? "语音生成"
            : "配置节点生成";
      act(() => {
        const button = findButton(renderer, (item) => item.props.title === safeAction || item.props["aria-label"] === safeAction);
        button.props.onClick();
      });
      renderer.unmount();
    }
    expect(browser.listeners.get("keydown")?.length ?? 0).toBe(0);
  });

  test("sends text, image, video, and audio prompts through real provider boundaries", async () => {
    installBrowserGlobals();
    const nodes: BoardNode[] = [
      createNode("text", { x: 0, y: 0 }, { id: "prompt-text", metadata: { content: "existing", prompt: "revise" } }),
      createNode("image", { x: 0, y: 0 }, { id: "prompt-image", metadata: { prompt: "draw" } }),
      createNode("video", { x: 0, y: 0 }, { id: "prompt-video", metadata: { prompt: "animate" } }),
      createNode("audio", { x: 0, y: 0 }, { id: "prompt-audio", metadata: { prompt: "speak" } }),
    ];
    seedProject(nodes, true);
    for (const node of nodes) {
      const renderer = render(<NodePromptBar node={node} />);
      const send = findButton(renderer, (item) => item.props["aria-label"] === "发送提示词");
      expect(send.props.disabled).toBe(false);
      await act(async () => {
        send.props.onClick();
        await settle();
      });
      expect(useBoardStore.getState().getActive()?.nodes.find((candidate) => candidate.id === node.id)?.metadata.status).toBe("error");
      renderer.unmount();
    }
  });

  test("renders BoardNodeView node-specific controls and invokes callbacks", () => {
    const browser = installBrowserGlobals();
    const text = createNode("text", { x: 20, y: 30 }, { id: "view-text", title: "Original", metadata: { content: "hello", fontSize: 14 } });
    const config = createNode("config", { x: 20, y: 30 }, { id: "view-config", metadata: { generationMode: "text", prompt: "from config" } });
    const upstream = createNode("text", { x: -300, y: 30 }, { id: "view-upstream", metadata: { content: "upstream" } });
    const project = seedProject([upstream, config], false).project;
    project.edges = [{ id: "view-edge", from: upstream.id, to: config.id }];
    let selected = false;
    let started = false;
    let connected = false;
    let resized = false;
    const renderer = render(
      <BoardNodeView
        node={config}
        selected
        related
        onSelect={() => { selected = true; }}
        onDragStart={() => { started = true; }}
        onResizeStart={() => { resized = true; }}
        onStartConnect={() => undefined}
        onCompleteConnect={() => { connected = true; }}
        generationChannels={[useBoardStore.getState().config.channels[0]!]} 
      />,
    );
    const shell = renderer.root.findByProps({ "data-node-id": config.id });
    act(() => shell.props.onPointerDown(event()));
    expect(selected).toBe(true);
    expect(started).toBe(true);
    const mode = renderer.root.findAllByType("select").find((item) => item.props.value === "text");
    expect(mode).toBeDefined();
    act(() => mode!.props.onChange({ target: { value: "image" } }));
    const prompt = renderer.root.findAllByProps({ "aria-label": "配置节点提示词" })[0]!;
    act(() => prompt.props.onChange({ target: { value: "changed" } }));
    const inputButtons = renderer.root.findAllByType("button").filter((item) => item.props["aria-label"]?.includes("输入"));
    if (inputButtons.length) act(() => inputButtons.at(-1)!.props.onClick());
    const resize = renderer.root.findByProps({ "data-resize-corner": "se" });
    act(() => resize.props.onPointerDown(event()));
    expect(resized).toBe(true);
    const inputPort = findButton(renderer, (item) => item.props.title === "输入端口");
    act(() => inputPort.props.onPointerDown(event()));
    expect(connected).toBe(true);
    expect(browser.listeners.get("keydown")?.length ?? 0).toBe(0);
    renderer.unmount();

    seedProject([text]);
    let titleUpdated = false;
    const textRenderer = render(
      <BoardNodeView
        node={text}
        selected={false}
        related={false}
        onSelect={() => undefined}
        onDragStart={() => undefined}
        onResizeStart={() => undefined}
        onStartConnect={() => undefined}
        onCompleteConnect={() => undefined}
        onContextMenu={() => { titleUpdated = true; }}
        generationChannels={[useBoardStore.getState().config.channels[0]!]} 
      />,
    );
    const title = textRenderer.root.findByProps({ "data-node-title": true });
    act(() => title.props.onDoubleClick(event()));
    const editor = textRenderer.root.findByProps({ "aria-label": "节点标题" });
    act(() => editor.props.onChange({ target: { value: " Renamed " } }));
    act(() => editor.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }));
    expect(useBoardStore.getState().getActive()?.nodes[0]?.title).toBe("Renamed");
    const textArea = textRenderer.root.findByType("textarea");
    act(() => textArea.props.onChange({ target: { value: "edited" } }));
    expect(useBoardStore.getState().getActive()?.nodes[0]?.metadata.content).toBe("edited");
    expect(titleUpdated).toBe(false);
    textRenderer.unmount();
  });

  test("renders video, image, group, and plugin node bodies", () => {
    installBrowserGlobals();
    const video = createNode("video", { x: 0, y: 0 }, { id: "body-video", metadata: { content: "https://example.test/video.mp4", status: "success" } });
    const image = createNode("image", { x: 0, y: 0 }, { id: "body-image", metadata: { content: "data:image/png;base64,AA==", status: "success" } });
    const group = createNode("group", { x: 0, y: 0 }, { id: "body-group", metadata: { childIds: ["a", "b"] } });
    const plugin = createNode("plugin", { x: 0, y: 0 }, { id: "body-plugin", metadata: { pluginId: "missing-plugin" } });
    for (const node of [video, image, group, plugin]) {
      seedProject([node]);
      const renderer = render(
        <BoardNodeView
          node={node}
          selected={node.type === "video"}
          related={false}
          onSelect={() => undefined}
          onDragStart={() => undefined}
          onResizeStart={() => undefined}
          onStartConnect={() => undefined}
          onCompleteConnect={() => undefined}
          generationChannels={[useBoardStore.getState().config.channels[0]!]} 
        />,
      );
      if (node.type === "video") {
        const play = findButton(renderer, (item) => item.props["aria-label"] === "播放视频");
        act(() => play.props.onClick());
      }
      if (node.type === "image") expect(renderer.root.findByType("img").props.src).toContain("data:image");
      if (node.type === "plugin") expect(renderer.root.findByProps({ "data-testid": "plugin-unavailable" })).toBeDefined();
      renderer.unmount();
    }
  });

  test("renders BoardCanvas and exercises toolbar, keyboard, minimap, and asset picker callbacks", async () => {
    const browser = installBrowserGlobals();
    const { project } = seedProject([]);
    const renderer = render(<BoardCanvas />);
    const addText = findButton(renderer, (item) => item.props["aria-label"] === "文本");
    act(() => addText.props.onClick());
    expect(useBoardStore.getState().getActive()?.nodes.some((node) => node.type === "text")).toBe(true);
    const background = findButton(renderer, (item) => item.props["aria-label"] === "背景");
    act(() => background.props.onClick());
    expect(useBoardStore.getState().getActive()?.backgroundMode).toBe("lines");
    const minimapToggle = findButton(renderer, (item) => item.props["aria-label"] === "小地图");
    act(() => minimapToggle.props.onClick());
    expect(useBoardStore.getState().showMinimap).toBe(false);
    const openAssets = findButton(renderer, (item) => item.props["aria-label"] === "素材");
    act(() => openAssets.props.onClick());
    expect(renderer.root.findByProps({ role: "dialog" })).toBeDefined();
    const closeAssets = findButton(renderer, (item) => item.props["aria-label"] === "关闭素材选择");
    act(() => closeAssets.props.onClick());
    expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);

    const zoomIn = findButton(renderer, (item) => item.props["aria-label"] === "放大");
    const zoomOut = findButton(renderer, (item) => item.props["aria-label"] === "缩小");
    act(() => {
      zoomIn.props.onClick();
      zoomOut.props.onClick();
    });
    const zoomInput = renderer.root.findByProps({ "aria-label": "缩放比例" });
    act(() => {
      zoomInput.props.onChange({ target: { value: "150" } });
      zoomInput.props.onBlur();
    });
    const minimap = renderer.root.findAllByProps({ "aria-label": "画布小地图" });
    if (minimap.length) {
      act(() => minimap[0]!.props.onClick({ clientX: 30, clientY: 20, currentTarget: new FakeElement() }));
    }

    const keydown = browser.listeners.get("keydown") ?? [];
    const keyup = browser.listeners.get("keyup") ?? [];
    const keyEvent = (key: string, extras: Record<string, unknown> = {}) => ({
      key,
      code: key === " " ? "Space" : key,
      target: new FakeElement(),
      preventDefault: () => undefined,
      ...extras,
    });
    act(() => {
      keydown.at(-1)?.(keyEvent("a", { metaKey: true }));
      keydown.at(-1)?.(keyEvent("g", { metaKey: true }));
      keydown.at(-1)?.(keyEvent("g", { metaKey: true, shiftKey: true }));
      keydown.at(-1)?.(keyEvent("d", { metaKey: true }));
      keydown.at(-1)?.(keyEvent("z", { metaKey: true }));
      keydown.at(-1)?.(keyEvent("z", { metaKey: true, shiftKey: true }));
      keydown.at(-1)?.(keyEvent("y", { metaKey: true }));
      keydown.at(-1)?.(keyEvent("Delete"));
      keydown.at(-1)?.(keyEvent("Escape"));
      keydown.at(-1)?.(keyEvent(" "));
      keyup.at(-1)?.(keyEvent(" "));
    });
    expect(project.id).toBe(useBoardStore.getState().getActive()?.id);
    await act(async () => { await settle(); });
    renderer.unmount();
  });
});
