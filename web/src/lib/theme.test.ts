import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { applyTheme, getStoredTheme, resolveEffectiveTheme, setupCrossTabThemeListener } from "./theme";

describe("theme management", () => {
  let originalStorage: any;
  let originalWindow: any;
  let originalDocument: any;

  let mockStorage: Record<string, string> = {};
  let mockClassList: Set<string> = new Set();
  let mockAttributes: Record<string, string> = {};
  let mockStyle: Record<string, string> = {};
  let eventListeners: Record<string, ((e: any) => void)[]> = {};

  beforeEach(() => {
    originalStorage = globalThis.localStorage;
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    mockStorage = {};
    mockClassList = new Set();
    mockAttributes = {};
    mockStyle = {};
    eventListeners = {};

    globalThis.localStorage = {
      getItem: (k: string) => mockStorage[k] ?? null,
      setItem: (k: string, v: string) => { mockStorage[k] = v; },
      removeItem: (k: string) => { delete mockStorage[k]; },
      clear: () => { mockStorage = {}; },
      length: 0,
      key: () => null,
    } as unknown as Storage;

    globalThis.window = {
      ...((originalWindow || {}) as any),
      addEventListener: (type: string, listener: any) => {
        if (!eventListeners[type]) eventListeners[type] = [];
        eventListeners[type].push(listener);
      },
      removeEventListener: (type: string, listener: any) => {
        if (eventListeners[type]) {
          eventListeners[type] = eventListeners[type].filter((l) => l !== listener);
        }
      },
      dispatchEvent: (event: any) => {
        const listeners = eventListeners[event.type] ?? [];
        for (const l of listeners) l(event);
        return true;
      },
      matchMedia: (query: string) => ({
        matches: query.includes("dark"),
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }),
    } as unknown as Window & typeof globalThis;

    globalThis.document = {
      ...((originalDocument || {}) as any),
      documentElement: {
        classList: {
          toggle: (cls: string, force?: boolean) => {
            if (force === undefined) {
              if (mockClassList.has(cls)) { mockClassList.delete(cls); return false; }
              mockClassList.add(cls); return true;
            }
            if (force) mockClassList.add(cls); else mockClassList.delete(cls);
            return force;
          },
          contains: (cls: string) => mockClassList.has(cls),
          remove: (cls: string) => mockClassList.delete(cls),
          add: (cls: string) => mockClassList.add(cls),
        },
        setAttribute: (k: string, v: string) => { mockAttributes[k] = v; },
        getAttribute: (k: string) => mockAttributes[k] ?? null,
        style: mockStyle as unknown as CSSStyleDeclaration,
      },
    } as unknown as Document;
  });

  afterEach(() => {
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("resolves explicit light and dark themes", () => {
    expect(resolveEffectiveTheme("light")).toBe("light");
    expect(resolveEffectiveTheme("dark")).toBe("dark");
  });

  test("applies light theme to document and persists", () => {
    const effective = applyTheme("light");
    expect(effective).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(getStoredTheme()).toBe("light");
  });

  test("applies dark theme to document and persists", () => {
    const effective = applyTheme("dark");
    expect(effective).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getStoredTheme()).toBe("dark");
  });

  test("applies system theme and stores system preference", () => {
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
    expect(getStoredTheme()).toBe("system");
  });

  test("listens to cross tab storage events", () => {
    let captured = "";
    const unsub = setupCrossTabThemeListener((theme) => {
      captured = theme;
    });

    // Simulate storage event
    window.dispatchEvent({
      type: "storage",
      key: "openboard-theme",
      newValue: "dark",
    });

    expect(captured).toBe("dark");
    unsub();
  });
});
