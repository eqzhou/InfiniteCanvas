import { describe, expect, test } from "bun:test";
import {
  MODEL_CATALOG_LIMITS,
  normalizeModelCatalog,
  resolveDefaultModel,
  resolveSelectableModels,
} from "./model-catalog";

describe("tenant model catalog", () => {
  test("narrows selectable models to the configured allow list", () => {
    const selectable = resolveSelectableModels(
      { availableModels: ["gpt-image-2", "gpt-5.5"] },
      ["gpt-image-2", "gpt-5.5", "secret-internal"],
    );
    expect(selectable).toEqual(["gpt-image-2", "gpt-5.5"]);
  });

  test("falls back to enabled channel models when the allow list is empty", () => {
    // An empty allow list must not strand the user with zero choices.
    expect(resolveSelectableModels({ availableModels: [] }, ["channel-a", "channel-b"]))
      .toEqual(["channel-a", "channel-b"]);
    expect(resolveSelectableModels(undefined, ["channel-a"])).toEqual(["channel-a"]);
  });

  test("ignores allow-list entries that no enabled channel provides", () => {
    expect(resolveSelectableModels({ availableModels: ["absent"] }, ["channel-a"]))
      .toEqual(["channel-a"]);
  });

  test("prefers the configured default when it is still selectable", () => {
    const catalog = { availableModels: ["a-image", "b-text"], defaultImageModel: "a-image" };
    expect(resolveDefaultModel(catalog, "image", ["a-image", "b-text"])).toBe("a-image");
  });

  test("falls back by kind keyword when the configured default became invalid", () => {
    const catalog = { defaultImageModel: "retired-model", defaultVideoModel: "retired-model" };
    const selectable = ["chat-pro", "seedream-4", "seedance-2.0", "gpt-image-2"];
    // Image prefers seedream/image/gpt-image; video prefers seedance/video.
    expect(resolveDefaultModel(catalog, "image", selectable)).toBe("seedream-4");
    expect(resolveDefaultModel(catalog, "video", selectable)).toBe("seedance-2.0");
    // Text prefers a model that is neither an image nor a video model.
    expect(resolveDefaultModel({}, "text", selectable)).toBe("chat-pro");
  });

  test("returns an empty default rather than inventing a model", () => {
    expect(resolveDefaultModel({}, "image", [])).toBe("");
  });

  test("normalizes hostile persisted catalogs", () => {
    const normalized = normalizeModelCatalog({
      availableModels: ["ok", "ok", "", 42, "x".repeat(500)],
      defaultImageModel: 7,
    });
    expect(normalized.availableModels).toEqual(["ok"]);
    expect(normalized.defaultImageModel).toBe("");

    const flooded = Array.from({ length: MODEL_CATALOG_LIMITS.maxModels + 10 }, (_, index) => `m${index}`);
    expect(normalizeModelCatalog({ availableModels: flooded }).availableModels)
      .toHaveLength(MODEL_CATALOG_LIMITS.maxModels);
    expect(normalizeModelCatalog(null).availableModels).toEqual([]);
  });
});
