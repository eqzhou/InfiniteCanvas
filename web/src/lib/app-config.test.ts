import { describe, expect, test } from "bun:test";
import { applySystemPrompt, mergeBuiltinPromptSources, normalizeAppConfig, SYSTEM_PROMPT_MAX_LENGTH } from "@/lib/app-config";
import { COMMUNITY_PROMPT_SOURCE_PRESETS } from "@/services/prompt-source-presets";
import { createDefaultConfig } from "@/lib/defaults";

describe("application configuration", () => {
  test("normalizes missing and oversized system prompts without mutating input", () => {
    const missing = { ...createDefaultConfig(), systemPrompt: undefined };
    const oversized = { ...createDefaultConfig(), systemPrompt: "x".repeat(SYSTEM_PROMPT_MAX_LENGTH + 5) };

    expect(normalizeAppConfig(missing as unknown as ReturnType<typeof createDefaultConfig>).systemPrompt)
      .toBe("");
    expect(normalizeAppConfig(oversized).systemPrompt).toHaveLength(SYSTEM_PROMPT_MAX_LENGTH);
    expect(oversized.systemPrompt).toHaveLength(SYSTEM_PROMPT_MAX_LENGTH + 5);
  });

  test("composes a system instruction before the user prompt", () => {
    expect(applySystemPrompt("  Keep the edit natural.  ", "replace the sky"))
      .toBe("Keep the edit natural.\n\nreplace the sky");
    expect(applySystemPrompt("", "replace the sky")).toBe("replace the sky");
  });

  test("bounds persisted generation defaults for video and audio", () => {
    const base = createDefaultConfig();
    const normalized = normalizeAppConfig({
      ...base,
      generationDefaults: {
        videoRatio: "21:9",
        videoResolution: "1080p",
        videoSeconds: 9,
        videoGenerateAudio: true,
        videoWatermark: true,
        audioVoice: "verse",
        audioFormat: "wav",
        audioSpeed: 1.5,
        audioInstructions: "  轻快地朗读  ",
      },
    } as unknown as ReturnType<typeof createDefaultConfig>);
    expect(normalized.generationDefaults).toMatchObject({
      videoRatio: "21:9",
      videoResolution: "1080p",
      videoSeconds: 9,
      videoGenerateAudio: true,
      videoWatermark: true,
      audioVoice: "verse",
      audioFormat: "wav",
      audioSpeed: 1.5,
      audioInstructions: "轻快地朗读",
    });

    // Hostile or out-of-range values fall back to safe defaults.
    const hostile = normalizeAppConfig({
      ...base,
      generationDefaults: {
        videoRatio: "9999:1",
        videoResolution: "16k",
        videoSeconds: 900,
        audioFormat: "exe",
        audioSpeed: 99,
        audioVoice: "x".repeat(500),
        audioInstructions: 42,
      },
    } as unknown as ReturnType<typeof createDefaultConfig>);
    expect(hostile.generationDefaults).toEqual({
      videoRatio: "16:9",
      videoResolution: "720p",
      videoSeconds: 5,
      videoGenerateAudio: false,
      videoWatermark: false,
      audioVoice: "alloy",
      audioFormat: "mp3",
      audioSpeed: 0,
      audioInstructions: "",
    });
    expect(normalizeAppConfig(base).generationDefaults?.videoRatio).toBe("16:9");
  });

  test("bounds persisted canvas panel preferences", () => {
    const base = createDefaultConfig();
    expect(normalizeAppConfig({
      ...base,
      canvasPanelWidth: 900,
      canvasPanelCollapsed: true,
      canvasPanelTab: "assets",
    })).toMatchObject({
      canvasPanelWidth: 420,
      canvasPanelCollapsed: true,
      canvasPanelTab: "assets",
    });
    expect(normalizeAppConfig({
      ...base,
      canvasPanelTab: "prompts",
    })).toMatchObject({
      canvasPanelTab: "prompts",
    });
    expect(normalizeAppConfig({
      ...base,
      canvasPanelWidth: 10,
      canvasPanelTab: "invalid" as "projects",
    })).toMatchObject({
      canvasPanelWidth: 240,
      canvasPanelCollapsed: false,
      canvasPanelTab: "projects",
    });
  });

  test("normalizes image toolbar preferences without mutating persisted input", () => {
    const base = createDefaultConfig();
    const imageToolbar = {
      order: ["crop", "download", "crop"],
      hidden: ["mask", "unknown"],
      showLabels: true,
    };
    const normalized = normalizeAppConfig({ ...base, imageToolbar } as unknown as typeof base);
    expect(imageToolbar.order).toEqual(["crop", "download", "crop"]);
    expect(normalized.imageToolbar?.order.slice(0, 2)).toEqual(["crop", "download"]);
    expect(normalized.imageToolbar?.hidden).toEqual(["mask"]);
    expect(normalized.imageToolbar?.showLabels).toBe(true);
  });

  test("normalizes preferred models without mutating legacy or persisted config", () => {
    const base = createDefaultConfig();
    const preferredModels = {
      "channel-a": { image: " image-v2 ", video: "video-v1", invalid: "ignored" },
      "bad channel": { image: "ignored" },
    };
    const normalized = normalizeAppConfig({
      ...base,
      preferredModels,
    } as unknown as typeof base);

    expect(normalized.preferredModels).toEqual({
      "channel-a": { image: "image-v2", video: "video-v1" },
    });
    expect(preferredModels["channel-a"]).toEqual({
      image: " image-v2 ", video: "video-v1", invalid: "ignored",
    });
    expect(normalizeAppConfig({ ...base, preferredModels: undefined } as unknown as typeof base).preferredModels)
      .toEqual({});
  });

  test("upgrades legacy prompt source URLs to bounded declarative configs", () => {
    const base = createDefaultConfig();
    const input = {
      ...base,
      promptSources: [
        "https://prompts.example/catalog.json",
        {
          id: "nested-source",
          name: "Nested catalog",
          url: "https://nested.example/data.json",
          format: "json",
          enabled: true,
          refreshMinutes: 30,
          mapping: { itemsPath: "payload.entries", titlePath: "label", bodyPath: "value" },
        },
        { id: "unsafe", name: "Unsafe", url: "javascript:alert(1)", format: "script" },
      ],
    };

    const normalized = normalizeAppConfig(input as unknown as ReturnType<typeof createDefaultConfig>);
    const builtinCount = COMMUNITY_PROMPT_SOURCE_PRESETS.length;

    // Built-in Image Prompts catalogs are always present, then custom sources.
    expect(normalized.promptSources?.length).toBe(builtinCount + 2);
    expect(normalized.promptSources?.slice(0, builtinCount).every((source) => source.builtIn)).toBe(true);
    expect(normalized.promptSources?.[builtinCount]).toMatchObject({
      name: "prompts.example",
      url: "https://prompts.example/catalog.json",
      format: "auto",
      enabled: true,
    });
    expect(normalized.promptSources?.[builtinCount + 1]).toMatchObject({
      id: "nested-source",
      refreshMinutes: 30,
      mapping: { itemsPath: "payload.entries", titlePath: "label", bodyPath: "value" },
    });
    expect(input.promptSources[0]).toBe("https://prompts.example/catalog.json");
  });

  test("merges built-in catalogs while preserving enablement and status", () => {
    const banana = COMMUNITY_PROMPT_SOURCE_PRESETS.find((item) => item.id === "banana-prompt-quicker")!;
    const merged = mergeBuiltinPromptSources([
      {
        ...banana.source,
        enabled: false,
        lastSuccessAt: "2026-07-21T00:00:00.000Z",
        itemCount: 12,
      },
      {
        id: "custom-json",
        name: "Custom",
        url: "https://custom.example/prompts.json",
        format: "json",
        enabled: true,
        refreshMinutes: 0,
      },
    ]);
    const kept = merged.find((item) => item.id === "banana-prompt-quicker");
    expect(kept?.enabled).toBe(false);
    expect(kept?.itemCount).toBe(12);
    expect(kept?.builtIn).toBe(true);
    expect(merged.some((item) => item.id === "custom-json")).toBe(true);
    expect(merged.filter((item) => item.builtIn).length).toBe(COMMUNITY_PROMPT_SOURCE_PRESETS.length);
  });
});
