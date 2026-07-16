import { describe, expect, test } from "bun:test";
import { applyChannelUrlCredentials, consumeUrlCredentials } from "./url-credentials";
import type { AiChannel } from "@/types/board";

const testCredential = (label: string) => `${label}-test-credential`;
const existingCredential = testCredential("existing");

const channel: AiChannel = {
  id: "channel",
  name: "Provider",
  baseUrl: "https://api.example.com/v1",
  apiKey: existingCredential,
  defaultTextModel: "text",
  defaultImageModel: "image",
  defaultVideoModel: "video",
};

describe("URL credential consumption", () => {
  test("consumes credentials only from a fragment and preserves ordinary query values", () => {
    const result = consumeUrlCredentials(
      "https://board.example/canvas?project=42&tag=a#connect?apiKey=sk-secret&baseUrl=https%3A%2F%2Fapi.example%2Fv1",
    );

    expect(result.credentials).toEqual({
      apiKey: "sk-secret",
      baseUrl: "https://api.example/v1",
    });
    expect(result.sanitizedPath).toBe("/canvas?project=42&tag=a");
    expect(result.hadSensitiveParams).toBe(true);
  });

  test("removes but never consumes legacy query credentials", () => {
    expect(consumeUrlCredentials("https://board.example/?apiKey=leaked&baseUrl=https://evil.example&keep=1#hash")).toEqual({
      credentials: {},
      sanitizedPath: "/?keep=1#hash",
      hadSensitiveParams: true,
    });
  });

  test("leaves an unrelated URL unchanged", () => {
    expect(consumeUrlCredentials("https://board.example/?keep=1#hash")).toEqual({
      credentials: {},
      sanitizedPath: "/?keep=1#hash",
      hadSensitiveParams: false,
    });
  });
});

describe("URL credential application", () => {
  test("applies fragment credentials to only the selected provider", () => {
    const videoCredential = testCredential("video");
    const updated = applyChannelUrlCredentials(channel, { provider: "video", baseUrl: "https://video.example/v1", apiKey: videoCredential });
    expect(updated.providers?.video).toMatchObject({ baseUrl: "https://video.example/v1", apiKey: videoCredential });
    expect(updated.apiKey).toBe(existingCredential);
    expect(updated.baseUrl).toBe("https://api.example.com/v1");
  });
  test("clears an existing key when the provider origin changes", () => {
    expect(applyChannelUrlCredentials(channel, { baseUrl: "https://other.example/v1" })).toMatchObject({
      baseUrl: "https://other.example/v1",
      apiKey: "",
    });
  });

  test("preserves a key for a same-origin path change and accepts an explicit replacement", () => {
    expect(applyChannelUrlCredentials(channel, { baseUrl: "https://api.example.com/api/v3" })).toMatchObject({
      apiKey: existingCredential,
    });
    expect(applyChannelUrlCredentials(channel, {
      baseUrl: "https://other.example/v1",
      apiKey: testCredential("new"),
    })).toMatchObject({ apiKey: testCredential("new") });
  });

  test("rejects insecure remote and credential-bearing provider URLs", () => {
    expect(() => applyChannelUrlCredentials(channel, { baseUrl: "http://api.example.com/v1" })).toThrow("HTTPS");
    expect(() => applyChannelUrlCredentials(channel, { baseUrl: "https://user:pass@api.example.com/v1" })).toThrow("credentials");
  });
});
