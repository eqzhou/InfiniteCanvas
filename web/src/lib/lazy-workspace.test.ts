import { describe, expect, test } from "bun:test";
import {
  canPersistLazySlice,
  keepLazyLoadPromise,
  resolveActiveProjectId,
  shouldAutoloadLazySlice,
  WorkspaceScopeChangedError,
} from "./lazy-workspace";

describe("lazy workspace helpers", () => {
  test("only autoloads an idle slice after the workspace is ready", () => {
    expect(shouldAutoloadLazySlice(false, "idle")).toBe(false);
    expect(shouldAutoloadLazySlice(true, "loading")).toBe(false);
    expect(shouldAutoloadLazySlice(true, "loaded")).toBe(false);
    expect(shouldAutoloadLazySlice(true, "error")).toBe(false);
    expect(shouldAutoloadLazySlice(true, "idle")).toBe(true);
  });

  test("refuses to persist a catalog that has not finished loading", () => {
    expect(canPersistLazySlice("idle")).toBe(false);
    expect(canPersistLazySlice("loading")).toBe(false);
    expect(canPersistLazySlice("error")).toBe(false);
    expect(canPersistLazySlice("loaded")).toBe(true);
  });

  test("keeps the current project when it still exists after a lazy load", () => {
    expect(resolveActiveProjectId("b", [{ id: "a" }, { id: "b" }])).toBe("b");
    expect(resolveActiveProjectId("gone", [{ id: "a" }, { id: "b" }])).toBe("a");
    expect(resolveActiveProjectId(null, [])).toBeNull();
  });

  test("names a discarded load so callers can fail closed", () => {
    const error = new WorkspaceScopeChangedError();
    expect(error.name).toBe("WorkspaceScopeChangedError");
    expect(error).toBeInstanceOf(Error);
  });

  test("does not drop a replacement in-flight promise from the cache", () => {
    const first = Promise.resolve();
    const second = Promise.resolve();
    const cache = new Map<string, Promise<void>>([["open:projects", second]]);
    keepLazyLoadPromise(cache, "open:projects", first);
    expect(cache.get("open:projects")).toBe(second);
    keepLazyLoadPromise(cache, "open:projects", second);
    expect(cache.has("open:projects")).toBe(false);
  });
});
