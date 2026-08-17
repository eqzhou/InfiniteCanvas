import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { changePassword, clearSessionToken, consumeOAuthSessionFragment, getSessionToken } from "./auth-session";

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

describe("change password", () => {
  test("sends the current and new password to the auth endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await changePassword("old-pass1", "new-pass1");
    expect(requests[0]?.url).toContain("/api/auth/password");
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(requests[0]?.init?.body).toBe(JSON.stringify({
      currentPassword: "old-pass1",
      newPassword: "new-pass1",
    }));
  });

  test("rejects a short password before calling the server", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(changePassword("old-password", "short")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
