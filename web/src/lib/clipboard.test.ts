import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type ClipboardStub = { writeText?: (value: string) => Promise<void> } | undefined;

let originalClipboard: ClipboardStub;
let originalExecCommand: typeof document.execCommand | undefined;
let bodyChildren: Element[] = [];

function installDom(): void {
  // Bun unit tests do not ship a full DOM. Stub only what the fallback path uses.
  const body = {
    appendChild(node: Element) {
      bodyChildren.push(node);
      return node;
    },
    removeChild(node: Element) {
      bodyChildren = bodyChildren.filter((child) => child !== node);
      return node;
    },
  };
  (globalThis as { document?: unknown }).document = {
    body,
    createElement(tag: string) {
      if (tag !== "textarea") throw new Error(`unexpected element: ${tag}`);
      return {
        value: "",
        style: {} as CSSStyleDeclaration,
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
      };
    },
    execCommand: originalExecCommand ?? (() => false),
  };
  if (typeof (globalThis as { navigator?: unknown }).navigator === "undefined") {
    (globalThis as { navigator: unknown }).navigator = {};
  }
  originalClipboard = (globalThis.navigator as { clipboard?: ClipboardStub }).clipboard;
  originalExecCommand = document.execCommand.bind(document);
}

beforeEach(() => {
  bodyChildren = [];
  installDom();
});

afterEach(() => {
  if (originalExecCommand) document.execCommand = originalExecCommand;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  mock.restore();
});

describe("writeTextWithFallback", () => {
  test("prefers the async clipboard API when it succeeds", async () => {
    const writeText = mock(async (value: string) => {
      expect(value).toBe("hello");
    });
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    document.execCommand = mock(() => {
      throw new Error("legacy path should not run");
    }) as typeof document.execCommand;

    const { writeTextWithFallback } = await import("./clipboard");
    await writeTextWithFallback("hello");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test("falls back to execCommand when clipboard.writeText rejects", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mock(async () => {
          throw new Error("NotAllowedError");
        }),
      },
    });
    const execCommand = mock((command: string) => {
      expect(command).toBe("copy");
      return true;
    });
    document.execCommand = execCommand as typeof document.execCommand;

    const { writeTextWithFallback } = await import("./clipboard");
    await writeTextWithFallback("over-lan");
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(bodyChildren).toHaveLength(0);
  });

  test("falls back when clipboard is missing entirely", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execCommand = mock(() => true);
    document.execCommand = execCommand as typeof document.execCommand;

    const { writeTextWithFallback } = await import("./clipboard");
    await writeTextWithFallback("plain-http");
    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  test("surfaces a failure when both paths fail", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mock(async () => {
          throw new Error("denied");
        }),
      },
    });
    document.execCommand = mock(() => false) as typeof document.execCommand;

    const { writeTextWithFallback } = await import("./clipboard");
    await expect(writeTextWithFallback("nope")).rejects.toThrow("复制失败");
  });
});
