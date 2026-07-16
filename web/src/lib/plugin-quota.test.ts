import { describe, expect, test } from "bun:test";

import { consumePluginQuota, createPluginQuota } from "./plugin-quota";

describe("plugin message quota", () => {
  test("allows bounded messages and rolls into a new time window", () => {
    const initial = createPluginQuota(1_000);
    const first = consumePluginQuota(initial, 1_100, 100, { maxMessages: 2, maxBytes: 250, windowMs: 1_000 });
    expect(first.allowed).toBe(true);
    const second = consumePluginQuota(first.quota, 1_200, 100, { maxMessages: 2, maxBytes: 250, windowMs: 1_000 });
    expect(second.allowed).toBe(true);
    const reset = consumePluginQuota(second.quota, 2_100, 100, { maxMessages: 2, maxBytes: 250, windowMs: 1_000 });
    expect(reset.allowed).toBe(true);
    expect(reset.quota.messages).toBe(1);
  });

  test("permanently blocks a frame that exceeds message or byte limits", () => {
    const initial = createPluginQuota(0);
    const first = consumePluginQuota(initial, 10, 200, { maxMessages: 2, maxBytes: 250, windowMs: 1_000 });
    const blocked = consumePluginQuota(first.quota, 20, 100, { maxMessages: 2, maxBytes: 250, windowMs: 1_000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.quota.blocked).toBe(true);
    expect(consumePluginQuota(blocked.quota, 2_000, 1, {
      maxMessages: 2,
      maxBytes: 250,
      windowMs: 1_000,
    }).allowed).toBe(false);
  });
});
