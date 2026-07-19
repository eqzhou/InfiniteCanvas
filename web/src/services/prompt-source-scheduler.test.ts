import { describe, expect, test } from "bun:test";
import { duePromptSources, refreshDuePromptSources } from "./prompt-source-scheduler";
import type { PromptSourceConfig } from "@/types/board";
import { createDefaultConfig } from "@/lib/defaults";

const source = (partial: Partial<PromptSourceConfig>): PromptSourceConfig => ({
  id: "source-one",
  name: "Source",
  url: "https://prompts.example/catalog.json",
  format: "json",
  enabled: true,
  refreshMinutes: 5,
  ...partial,
});

describe("prompt source scheduler", () => {
  test("refreshes enabled due sources on every application route", () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const due = duePromptSources([
      source({ id: "due", lastFetchedAt: "2026-07-19T11:54:59.000Z" }),
      source({ id: "recent", lastFetchedAt: "2026-07-19T11:59:00.000Z" }),
      source({ id: "disabled", enabled: false }),
      source({ id: "manual", refreshMinutes: 0 }),
    ], now);

    expect(due.map((item) => item.id)).toEqual(["due"]);
  });

  test("merges against authoritative persisted state and stops committing after focus loss", async () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const scheduled = source({ id: "due", lastFetchedAt: "2026-07-19T11:00:00.000Z" });
    const staleConfig = { ...createDefaultConfig(), promptSources: [scheduled] };
    const persistedConfig = {
      ...createDefaultConfig(),
      channels: createDefaultConfig().channels.map((channel) => ({ ...channel, name: "Other tab channel" })),
      promptSources: [scheduled],
    };
    let active = true;
    let nextConfig = staleConfig;
    let nextPrompts = [{ id: "stale", title: "Stale", body: "old", tags: [] as string[] }];
    await refreshDuePromptSources(now, {
      isActive: () => active,
      flush: async () => undefined,
      loadConfig: async () => persistedConfig,
      loadPrompts: async () => [{ id: "other", title: "Other tab", body: "keep", tags: [] }],
      fetchSource: async () => [{ id: "remote", title: "Remote", body: "new", tags: [] }],
      getState: () => ({
        config: staleConfig,
        prompts: nextPrompts,
        setConfig: (config) => { nextConfig = config; },
        setPrompts: (prompts) => { nextPrompts = prompts; },
      }),
    });
    expect(nextConfig.channels[0]?.name).toBe("Other tab channel");
    expect(nextPrompts).toMatchObject([
      { id: "other", body: "keep" },
      { body: "new", sourceId: "due" },
    ]);

    active = false;
    nextPrompts = [];
    await refreshDuePromptSources(now, {
      isActive: () => active,
      flush: async () => undefined,
      loadConfig: async () => persistedConfig,
      loadPrompts: async () => [],
      fetchSource: async () => [{ id: "ignored", title: "Ignored", body: "ignored", tags: [] }],
      getState: () => ({
        config: staleConfig,
        prompts: nextPrompts,
        setConfig: () => { throw new Error("inactive scheduler wrote config"); },
        setPrompts: () => { throw new Error("inactive scheduler wrote prompts"); },
      }),
    });
    expect(nextPrompts).toEqual([]);
  });

  test("does not overwrite a newer manual refresh", async () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const scheduled = source({ id: "due", lastFetchedAt: "2026-07-19T11:00:00.000Z" });
    const initial = { ...createDefaultConfig(), promptSources: [scheduled] };
    const manuallyRefreshed = {
      ...initial,
      promptSources: [{ ...scheduled, lastFetchedAt: "2026-07-19T11:59:30.000Z" }],
    };
    let configReads = 0;
    let committed = false;

    await refreshDuePromptSources(now, {
      isActive: () => true,
      flush: async () => undefined,
      loadConfig: async () => configReads++ === 0 ? initial : manuallyRefreshed,
      loadPrompts: async () => [],
      fetchSource: async () => [{
        id: "old-result", title: "Old", body: "Old", tags: [], source: "Source", sourceId: "due",
      }],
      getState: () => ({
        config: initial,
        prompts: [],
        setConfig: () => { committed = true; },
        setPrompts: () => { committed = true; },
      }),
    });

    expect(committed).toBe(false);
  });
});
