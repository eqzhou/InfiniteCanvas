import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearSessionToken, consumeOAuthSessionFragment, getSessionToken } from "./auth-session";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, String(value));
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    },
  });
});

afterEach(() => {
  clearSessionToken();
  memory.clear();
});

describe("oauth session fragment", () => {
  test("stores the openboard_session fragment token", () => {
    const token = consumeOAuthSessionFragment("http://127.0.0.1:5173/prompts#openboard_session=sess-123&x=1");
    expect(token).toBe("sess-123");
    expect(getSessionToken()).toBe("sess-123");
  });

  test("ignores unrelated hashes", () => {
    expect(consumeOAuthSessionFragment("http://127.0.0.1:5173/#foo=bar")).toBeNull();
    expect(getSessionToken()).toBeNull();
  });

  test("returns null for empty or invalid href", () => {
    expect(consumeOAuthSessionFragment("")).toBeNull();
    expect(consumeOAuthSessionFragment("not a url")).toBeNull();
  });
});
