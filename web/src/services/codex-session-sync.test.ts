import { describe, expect, test } from "bun:test";
import {
  parseCodexSharedState,
  createCodexSessionSync,
  shouldResetCodexTranscript,
  statusForCodexSnapshot,
} from "./codex-session-sync";

describe("Codex shared session state", () => {
  test("accepts bounded session and running state without mutating input", () => {
    const input = { scopeKey: "scope-one", profile: "default", session: { id: "codex-one", threadId: "thread-one", running: true }, turnStatus: "running", updatedAt: 10, sourceId: "tab-one" };
    const parsed = parseCodexSharedState(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  test("rejects malformed profiles, sessions, and statuses", () => {
    expect(parseCodexSharedState({ scopeKey: "../bad", profile: "default", session: null, turnStatus: "idle", updatedAt: 1, sourceId: "tab" })).toBeNull();
    expect(parseCodexSharedState({ scopeKey: "scope-one", profile: "../bad", session: null, turnStatus: "idle", updatedAt: 1, sourceId: "tab" })).toBeNull();
    expect(parseCodexSharedState({ scopeKey: "scope-one", profile: "default", session: { id: "../bad" }, turnStatus: "idle", updatedAt: 1, sourceId: "tab" })).toBeNull();
    expect(parseCodexSharedState({ scopeKey: "scope-one", profile: "default", session: null, turnStatus: "tool-completed", updatedAt: 1, sourceId: "tab" })).toBeNull();
  });

  test("resets transcript only when a shared session switches threads", () => {
    expect(shouldResetCodexTranscript("session-one", "session-two")).toBe(true);
    expect(shouldResetCodexTranscript("session-one", "session-one")).toBe(false);
    expect(shouldResetCodexTranscript(undefined, "session-one")).toBe(true);
    expect(shouldResetCodexTranscript("session-one", undefined)).toBe(false);
  });

  test("keeps a never-started session idle and completes only a running turn", () => {
    expect(statusForCodexSnapshot("idle", false)).toBe("idle");
    expect(statusForCodexSnapshot("running", false)).toBe("completed");
    expect(statusForCodexSnapshot("failed", false)).toBe("failed");
    expect(statusForCodexSnapshot("idle", true)).toBe("running");
  });

  test("publishes, receives, orders, and closes cross-tab session state", () => {
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const priorChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    const values = new Map<string, string>();
    const fakeWindow = new EventTarget();
    const channels: FakeChannel[] = [];
    class FakeChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      posted: unknown[] = [];
      closed = false;
      constructor(readonly name: string) {
        channels.push(this);
      }
      postMessage(value: unknown) {
        this.posted.push(structuredClone(value));
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: FakeChannel });
    const initial = {
      scopeKey: "default",
      profile: "default",
      session: { id: "session-initial", running: false },
      turnStatus: "idle",
      updatedAt: 10,
      sourceId: "tab-initial",
    };
    values.set("openboard:codex-session:default:default", JSON.stringify(initial));
    const received: unknown[] = [];
    try {
      const sync = createCodexSessionSync("default", (state) => received.push(state));
      expect(sync.initial).toEqual(initial);
      sync.publish({ id: "session-next", running: true }, "running");
      const published = JSON.parse(values.get("openboard:codex-session:default:default") ?? "{}");
      expect(published).toMatchObject({
        profile: "default",
        session: { id: "session-next", running: true },
        turnStatus: "running",
      });
      expect(channels[0].name).toBe("openboard:codex-session");
      expect(channels[0].posted).toHaveLength(1);

      channels[0].onmessage?.({ data: {
        scopeKey: "other-scope",
        profile: "default",
        session: { id: "session-other", running: false },
        turnStatus: "completed",
        updatedAt: published.updatedAt + 1,
        sourceId: "tab-other-scope",
      } } as MessageEvent);
      channels[0].onmessage?.({ data: {
        scopeKey: "default",
        profile: "default",
        session: { id: "session-remote", running: false },
        turnStatus: "completed",
        updatedAt: published.updatedAt + 1,
        sourceId: "tab-remote",
      } } as MessageEvent);
      channels[0].onmessage?.({ data: {
        scopeKey: "default",
        profile: "default",
        session: { id: "session-stale", running: false },
        turnStatus: "idle",
        updatedAt: 1,
        sourceId: "tab-stale",
      } } as MessageEvent);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ session: { id: "session-remote" } });

      sync.close();
      expect(channels[0].closed).toBe(true);
    } finally {
      if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      if (priorChannel) Object.defineProperty(globalThis, "BroadcastChannel", priorChannel);
      else delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    }
  });

  test("ignores malformed stored state and survives unavailable browser transports", () => {
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const priorChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    const fakeWindow = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => "{bad json",
        setItem: () => { throw new Error("storage disabled"); },
      },
    });
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: class { constructor() { throw new Error("channel disabled"); } },
    });
    try {
      const sync = createCodexSessionSync("default", () => {
        throw new Error("invalid state must not be delivered");
      });
      expect(sync.initial).toBeNull();
      expect(() => sync.publish(null, "idle")).not.toThrow();
      expect(() => sync.close()).not.toThrow();
    } finally {
      if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      if (priorChannel) Object.defineProperty(globalThis, "BroadcastChannel", priorChannel);
      else delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    }
  });
});
