import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "@/lib/defaults";
import {
  exportConfigFile,
  hasSameChannelConfiguration,
  importConfigFile,
} from "@/lib/config-file";
import type { AppConfig } from "@/types/board";

describe("configuration file", () => {
  test("exports preferences and provider destinations without credentials", () => {
    const base = createDefaultConfig();
    const channel = base.channels[0]!;
    const legacyCredential = "fixture-legacy-credential";
    const textCredential = "fixture-text-credential";
    const webdavCredential = "fixture-webdav-credential";
    const storageCredential = "fixture-storage-credential";
    const config = {
      ...base,
      channels: [{
        ...channel,
        apiKey: legacyCredential,
        providers: {
          ...channel.providers!,
          text: { ...channel.providers!.text, apiKey: textCredential },
        },
      }],
      webdavPass: webdavCredential,
      objectStorage: {
        ...base.objectStorage!,
        accessKeyId: storageCredential,
        secretAccessKey: storageCredential,
        sessionToken: storageCredential,
      },
      theme: "dark" as const,
    };

    const exported = exportConfigFile(config);

    expect(exported.schema).toBe("openboard-config");
    expect(exported.version).toBe(1);
    expect(exported.config.theme).toBe("dark");
    expect(JSON.stringify(exported)).not.toContain(legacyCredential);
    expect(JSON.stringify(exported)).not.toContain(textCredential);
    expect(JSON.stringify(exported)).not.toContain(webdavCredential);
    expect(JSON.stringify(exported)).not.toContain(storageCredential);
  });

  test("imports a bounded file while preserving the current credentials", () => {
    const base = createDefaultConfig();
    const channel = base.channels[0]!;
    const currentTextCredential = "fixture-current-text-credential";
    const currentStorageCredential = "fixture-current-storage-credential";
    const current = {
      ...base,
      channels: [{
        ...channel,
        providers: {
          ...channel.providers!,
          text: { ...channel.providers!.text, apiKey: currentTextCredential },
        },
      }],
      objectStorage: {
        ...base.objectStorage!,
        accessKeyId: currentStorageCredential,
        secretAccessKey: currentStorageCredential,
      },
    };
    const incoming = exportConfigFile({ ...current, theme: "dark", imageCount: 4 });

    const restored = importConfigFile(JSON.stringify(incoming), current);

    expect(restored.theme).toBe("dark");
    expect(restored.imageCount).toBe(4);
    expect(restored.channels[0]?.providers?.text.apiKey).toBe(currentTextCredential);
    expect(restored.objectStorage?.accessKeyId).toBe(currentStorageCredential);
    expect(restored.objectStorage?.secretAccessKey).toBe(currentStorageCredential);
  });

  test("drops credentials when an imported provider or backup destination changes", () => {
    const base = createDefaultConfig();
    const channel = base.channels[0]!;
    const providerCredential = "fixture-provider-secret";
    const current = {
      ...base,
      channels: [{
        ...channel,
        providers: {
          ...channel.providers!,
          text: {
            ...channel.providers!.text,
            baseUrl: "https://trusted.example/v1",
            apiKey: providerCredential,
          },
        },
      }],
      webdavUrl: "https://trusted.example/dav",
      webdavUser: "trusted-user",
      webdavPass: "fixture-webdav-secret",
      objectStorage: {
        ...base.objectStorage!,
        endpoint: "https://trusted.example/storage",
        bucket: "trusted-bucket",
        accessKeyId: "fixture-storage-id",
        secretAccessKey: "fixture-storage-secret",
        sessionToken: "fixture-storage-session",
      },
    };
    const incoming = exportConfigFile(current) as unknown as {
      config: AppConfig;
    };
    incoming.config.channels[0]!.providers!.text.baseUrl = "https://attacker.example/v1";
    incoming.config.webdavUrl = "https://attacker.example/dav";
    incoming.config.objectStorage = {
      ...incoming.config.objectStorage!,
      endpoint: "https://attacker.example/storage",
    };

    const restored = importConfigFile(JSON.stringify(incoming), current);

    expect(restored.channels[0]?.providers?.text.apiKey).toBe("");
    expect(restored.webdavPass).toBe("");
    expect(restored.objectStorage?.accessKeyId).toBe("");
    expect(restored.objectStorage?.secretAccessKey).toBe("");
    expect(restored.objectStorage?.sessionToken).toBe("");
  });

  test("keeps one provider credential only when its complete credential route is unchanged", () => {
    const base = createDefaultConfig();
    const channel = base.channels[0]!;
    const textCredential = "fixture-text-secret";
    const imageCredential = "fixture-image-secret";
    const current = {
      ...base,
      channels: [{
        ...channel,
        providers: {
          ...channel.providers!,
          text: { ...channel.providers!.text, apiKey: textCredential },
          image: { ...channel.providers!.image, apiKey: imageCredential },
        },
      }],
    };
    const incoming = exportConfigFile(current) as unknown as { config: AppConfig };
    incoming.config.channels[0]!.providers!.image.protocol = "gemini";

    const restored = importConfigFile(JSON.stringify(incoming), current);

    expect(restored.channels[0]?.providers?.text.apiKey).toBe(textCredential);
    expect(restored.channels[0]?.providers?.image.apiKey).toBe("");
  });

  test("detects channel changes before a policy-locked import is applied", () => {
    const current = createDefaultConfig();
    expect(hasSameChannelConfiguration(current, structuredClone(current))).toBe(true);

    const changed = structuredClone(current);
    changed.channels[0]!.providers!.image.model = "different-model";
    expect(hasSameChannelConfiguration(current, changed)).toBe(false);
  });

  test("imports Azure and Edge audio provider protocols", () => {
    const current = createDefaultConfig();
    const channel = current.channels[0]!;
    for (const protocol of ["azure", "edge"] as const) {
      const incoming = exportConfigFile({
        ...current,
        channels: [{
          ...channel,
          providers: {
            ...channel.providers!,
            audio: { ...channel.providers!.audio, protocol },
          },
        }],
      });
      expect(importConfigFile(JSON.stringify(incoming), current).channels[0]?.providers?.audio.protocol)
        .toBe(protocol);
    }
  });

  test("does not export the retired global audio role mapping", () => {
    const current = createDefaultConfig();
    const incoming = exportConfigFile({
      ...current,
      audioRoles: [{
        id: "narrator",
        name: "旁白",
        voices: {
          openai: "coral",
          azure: "zh-CN-XiaoxiaoNeural",
          edge: "zh-CN-YunxiNeural",
        },
      }],
    });

    expect(incoming.config.audioRoles).toBeUndefined();
  });

  test("does not import executable extension surfaces", () => {
    const current = {
      ...createDefaultConfig(),
      pluginRegistryUrl: "https://trusted.example/plugins.json",
    };
    const incoming = exportConfigFile(current) as unknown as {
      config: Record<string, unknown>;
    };
    incoming.config.pluginRegistryUrl = "https://untrusted.example/plugins.json";
    incoming.config.plugins = [{ id: "untrusted-plugin" }];
    incoming.config.promptSources = [{
      id: "untrusted-source",
      name: "Untrusted",
      url: "https://untrusted.example/source.js",
      format: "script",
      enabled: true,
      refreshMinutes: 1,
      script: "return fetchJson('https://untrusted.example/data')",
    }];

    const restored = importConfigFile(JSON.stringify(incoming), current);

    expect(restored.pluginRegistryUrl).toBe("https://trusted.example/plugins.json");
    expect(restored.plugins).toEqual(current.plugins);
    expect(restored.promptSources).toEqual(current.promptSources);
  });

  test("rejects unknown, oversized, and malformed bundles", () => {
    const current = createDefaultConfig();
    expect(() => importConfigFile("{}", current)).toThrow("配置文件格式无效");
    expect(() => importConfigFile("{", current)).toThrow("配置文件不是有效 JSON");
    expect(() => importConfigFile(" ".repeat(1_048_577), current)).toThrow("配置文件过大");
    const malformed = exportConfigFile(current) as unknown as {
      config: Record<string, unknown>;
    };
    malformed.config.channels = [{ id: "broken" }];
    expect(() => importConfigFile(JSON.stringify(malformed), current))
      .toThrow("配置文件中的渠道无效");
  });
});
