import { describe, expect, test } from "bun:test";
import { resolveWebStorageMode } from "../../build-storage-mode";

describe("web build storage mode", () => {
  test("defaults production builds to PostgreSQL-backed server storage", () => {
    expect(resolveWebStorageMode("build", undefined)).toBe("server");
    expect(resolveWebStorageMode("build", "")).toBe("server");
  });

  test("keeps development local unless explicitly configured", () => {
    expect(resolveWebStorageMode("serve", undefined)).toBe("local");
    expect(resolveWebStorageMode("serve", "server")).toBe("server");
  });

  test("honors an explicit local production build", () => {
    expect(resolveWebStorageMode("build", "local")).toBe("local");
  });

  test("rejects unknown storage modes instead of silently losing the workspace", () => {
    expect(() => resolveWebStorageMode("build", "postgres")).toThrow("VITE_OPENBOARD_STORAGE");
  });
});
