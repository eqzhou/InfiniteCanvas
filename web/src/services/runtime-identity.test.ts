import { describe, expect, test } from "bun:test";
import {
  claimRuntimeOwnerLease,
  getRuntimeClientId,
  getRuntimeOwnerId,
  refreshRuntimeOwnerLease,
  releaseRuntimeOwnerLease,
  resolveRuntimeOwnerId,
  setRuntimeClientId,
  startRuntimeOwnerLease,
} from "./runtime-identity";

describe("runtime owner identity", () => {
  test("persists a bounded tab owner across reloads without reusing invalid values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const first = resolveRuntimeOwnerId(storage, () => "owner-first");
    const reloaded = resolveRuntimeOwnerId(storage, () => "owner-second");
    expect(reloaded).toBe(first);

    values.set("openboard:runtime-owner-id", "../invalid");
    expect(resolveRuntimeOwnerId(storage, () => "owner-safe")).toBe("owner-safe");
  });

  test("assigns a new owner to a duplicated live tab but permits a released reload", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-shared"]]);
    const leaseValues = new Map<string, string>();
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const leases = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => { leaseValues.set(key, value); },
      removeItem: (key: string) => { leaseValues.delete(key); },
    };
    const first = claimRuntimeOwnerLease(session, leases, "tab-one", 100, () => "owner-new");
    expect(first).toBe("owner-shared");
    const duplicate = claimRuntimeOwnerLease(session, leases, "tab-two", 101, () => "owner-new");
    expect(duplicate).toBe("owner-new");

    releaseRuntimeOwnerLease(leases, duplicate, "tab-two");
    sessionValues.set("openboard:runtime-owner-id", duplicate);
    expect(claimRuntimeOwnerLease(session, leases, "tab-reload", 102, () => "owner-unused"))
      .toBe(duplicate);
  });

  test("never reuses a stale lease owned by another live instance", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-stale"]]);
    const leaseValues = new Map<string, string>([[
      "openboard:runtime-owner-lease:owner-stale",
      JSON.stringify({ instanceId: "tab-old", updatedAt: 1 }),
    ]]);
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const leases = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => { leaseValues.set(key, value); },
      removeItem: (key: string) => { leaseValues.delete(key); },
    };

    expect(claimRuntimeOwnerLease(session, leases, "tab-new", 999_999, () => "owner-new"))
      .toBe("owner-new");
    expect(JSON.parse(leaseValues.get("openboard:runtime-owner-lease:owner-stale") ?? "{}"))
      .toMatchObject({ instanceId: "tab-old" });
  });

  test("a resumed tab changes owner instead of overwriting a newer claimant", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-shared"]]);
    const leaseValues = new Map<string, string>([[
      "openboard:runtime-owner-lease:owner-shared",
      JSON.stringify({ instanceId: "tab-new", updatedAt: 200 }),
    ]]);
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const leases = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => { leaseValues.set(key, value); },
      removeItem: (key: string) => { leaseValues.delete(key); },
    };

    expect(refreshRuntimeOwnerLease(session, leases, "owner-shared", "tab-old", 201, () => "owner-recovered"))
      .toBe("owner-recovered");
    expect(JSON.parse(leaseValues.get("openboard:runtime-owner-lease:owner-shared") ?? "{}"))
      .toMatchObject({ instanceId: "tab-new" });
  });

  test("uses a process-local owner when lease storage is unavailable", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-copied"]]);
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const unavailable = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
      removeItem: () => { throw new Error("storage disabled"); },
    };

    expect(claimRuntimeOwnerLease(session, unavailable, "tab-new", 100, () => "owner-isolated"))
      .toBe("owner-isolated");
    expect(sessionValues.get("openboard:runtime-owner-id")).toBe("owner-isolated");
  });

  test("falls back safely when session storage or generated ids are invalid", () => {
    const unavailable = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
    };
    expect(resolveRuntimeOwnerId(unavailable, () => "owner-fallback")).toBe("owner-fallback");
    expect(resolveRuntimeOwnerId(unavailable, () => "../invalid")).toBe("");

    const values = new Map<string, string>([["openboard:runtime-owner-id", "../invalid"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(resolveRuntimeOwnerId(storage, () => "owner-valid")).toBe("owner-valid");
    expect(claimRuntimeOwnerLease({
      getItem: () => "owner-valid",
      setItem: () => undefined,
    }, {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }, "tab-one", 10, () => "../invalid")).toBe("owner-valid");
  });

  test("handles lease write races and best-effort cleanup failures", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-race"]]);
    let writes = 0;
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => sessionValues.set(key, value),
    };
    const leaseValues = new Map<string, string>();
    const leases = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        leaseValues.set(key, writes === 1 ? JSON.stringify({ instanceId: "tab-other", updatedAt: 1 }) : value);
      },
      removeItem: (key: string) => leaseValues.delete(key),
    };
    expect(claimRuntimeOwnerLease(session, leases, "tab-one", 10, () => "owner-new")).toBe("owner-new");
    expect(writes).toBeGreaterThan(1);

    const brokenRefresh = {
      getItem: () => null,
      setItem: () => { throw new Error("read-only"); },
      removeItem: () => { throw new Error("read-only"); },
    };
    expect(refreshRuntimeOwnerLease(session, brokenRefresh, "owner-new", "tab-one", 11, () => "owner-other"))
      .toBe("owner-new");
    releaseRuntimeOwnerLease(brokenRefresh, "owner-new", "tab-one");
    releaseRuntimeOwnerLease(leases, "owner-new", "tab-one");
  });

  test("refreshes and releases a browser lease on interval and storage events", () => {
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const priorSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const priorLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const sessionValues = new Map<string, string>();
    const leaseValues = new Map<string, string>();
    const listeners = new Map<string, EventListener>();
    let intervalCallback: (() => void) | undefined;
    let clearedTimer: number | undefined;
    const fakeWindow = {
      setInterval: (callback: () => void) => { intervalCallback = callback; return 17; },
      clearInterval: (timer: number) => { clearedTimer = timer; },
      addEventListener: (type: string, listener: EventListener) => { listeners.set(type, listener); },
      removeEventListener: (type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    };
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => sessionValues.set(key, value),
    };
    const local = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => leaseValues.set(key, value),
      removeItem: (key: string) => leaseValues.delete(key),
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    try {
      const stop = startRuntimeOwnerLease();
      expect(intervalCallback).toBeFunction();
      expect(listeners.has("storage")).toBe(true);
      expect(listeners.has("pagehide")).toBe(true);
      intervalCallback?.();
      const storageListener = listeners.get("storage");
      storageListener?.({ key: `unrelated` } as StorageEvent);
      storageListener?.({ key: `openboard:runtime-owner-lease:${getRuntimeOwnerId()}` } as StorageEvent);
      expect(getRuntimeOwnerId()).toMatch(/^[A-Za-z0-9_-]+$/);
      stop();
      expect(clearedTimer).toBe(17);
      expect(listeners.size).toBe(0);
    } finally {
      if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
      else delete (globalThis as { window?: Window }).window;
      if (priorSession) Object.defineProperty(globalThis, "sessionStorage", priorSession);
      else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
      if (priorLocal) Object.defineProperty(globalThis, "localStorage", priorLocal);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test("keeps only bounded client ids", () => {
    setRuntimeClientId("client-1");
    expect(getRuntimeClientId()).toBe("client-1");
    setRuntimeClientId("bad id");
    expect(getRuntimeClientId()).toBe("");
    setRuntimeClientId("x".repeat(129));
    expect(getRuntimeClientId()).toBe("");
  });
});
