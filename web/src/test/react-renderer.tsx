import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import type { ElementType, ReactElement, ReactNode } from "react";

type EventListener = (...args: unknown[]) => void;

type BrowserSnapshot = {
  values: Map<string, unknown>;
  had: Set<string>;
};

/**
 * The Bun test runtime intentionally has no DOM.  React test renderer still
 * exercises component render/effect/event paths, so provide only the browser
 * surface those paths ask for and restore every global in `restoreBrowser`.
 */
export function installBrowser(): BrowserSnapshot {
  const names = [
    "window", "document", "location", "HTMLElement", "Element", "Node",
    "MutationObserver", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame",
    "CSS", "IS_REACT_ACT_ENVIRONMENT",
  ];
  const values = new Map<string, unknown>();
  const had = new Set<string>();
  for (const name of names) {
    if (name in globalThis) had.add(name);
    values.set(name, (globalThis as Record<string, unknown>)[name]);
  }

  const listeners = new Map<string, Set<EventListener>>();
  const addListener = (type: string, listener: EventListener) => {
    const current = listeners.get(type) ?? new Set<EventListener>();
    current.add(listener);
    listeners.set(type, current);
  };
  const removeListener = (type: string, listener: EventListener) => listeners.get(type)?.delete(listener);
  const dispatch = (event: { type: string }) => {
    for (const listener of listeners.get(event.type) ?? []) listener(event);
    return true;
  };
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
  const document = {
    activeElement: null,
    body: {},
    documentElement: { lang: "" },
    createElement: (tag: string) => {
      if (tag === "a") return { href: "", download: "", click: () => undefined };
      if (tag === "canvas") return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined, imageSmoothingEnabled: true, imageSmoothingQuality: "high" }),
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["preview"], { type: "image/webp" })),
      };
      return { style: {}, setAttribute: () => undefined, removeAttribute: () => undefined, click: () => undefined };
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: addListener,
    removeEventListener: removeListener,
  };
  const location = { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "", hash: "" };
  const window = {
    document,
    location,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: addListener,
    removeEventListener: removeListener,
    dispatchEvent: dispatch,
    getComputedStyle: () => ({}),
  };
  class TestElement {
    focus() { (document as { activeElement: unknown }).activeElement = this; }
    closest() { return null; }
    contains() { return false; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }; }
    querySelectorAll() { return []; }
    scrollIntoView() { return undefined; }
  }
  class TestObserver {
    observe() { return undefined; }
    disconnect() { return undefined; }
  }
  const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrame = (id: number) => clearTimeout(id);
  Object.assign(globalThis, {
    window,
    document,
    location,
    HTMLElement: TestElement,
    Element: TestElement,
    Node: TestElement,
    MutationObserver: TestObserver,
    ResizeObserver: TestObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return { values, had };
}

export function restoreBrowser(snapshot: BrowserSnapshot): void {
  for (const [name, value] of snapshot.values) {
    if (snapshot.had.has(name)) (globalThis as Record<string, unknown>)[name] = value;
    else delete (globalThis as Record<string, unknown>)[name];
  }
}

export async function renderRenderer(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
    await Promise.resolve();
  });
  return renderer;
}

export async function flushRenderer(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

export async function fire(callback: () => unknown): Promise<void> {
  await act(async () => {
    await callback();
    await Promise.resolve();
  });
}

export function nodeText(node: ReactTestInstance | ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("children" in node)) return "";
  return (node as ReactTestInstance).children.map((child) => nodeText(child)).join("");
}

export function hostNodes(renderer: ReactTestRenderer, type: string): ReactTestInstance[] {
  return renderer.root.findAllByType(type as ElementType);
}

export function hostButton(renderer: ReactTestRenderer, text: string): ReactTestInstance {
  const button = hostNodes(renderer, "button").find((candidate) => nodeText(candidate).includes(text));
  if (!button) throw new Error(`button not found: ${text}; available=${hostNodes(renderer, "button").map((node) => JSON.stringify({ text: nodeText(node), aria: node.props["aria-label"] })).join(" | ")}`);
  return button;
}

export function hostInput(renderer: ReactTestRenderer, predicate: (node: ReactTestInstance) => boolean): ReactTestInstance {
  const input = hostNodes(renderer, "input").find(predicate);
  if (!input) throw new Error(`input not found: ${hostNodes(renderer, "input").map((node) => JSON.stringify({ placeholder: node.props.placeholder, type: node.props.type, value: node.props.value, aria: node.props["aria-label"] })).join(" | ")}`);
  return input;
}

export function hostSelect(renderer: ReactTestRenderer, predicate: (node: ReactTestInstance) => boolean): ReactTestInstance {
  const select = hostNodes(renderer, "select").find(predicate);
  if (!select) throw new Error("select not found");
  return select;
}
