import { describe, expect, test } from "bun:test";

import { createDefaultObjectStorage, validateObjectStorageConfig } from "./object-storage";
import { resolveTemplateEndpoint } from "./provider-template";
import { normalizeAgentBaseUrl } from "@/services/local-agent";
import { joinProviderUrl } from "@/services/provider-http";
import type { AiTemplateConfig } from "@/types/board";

/**
 * Every validator below relaxes the HTTPS requirement for loopback endpoints.
 * They each used to compare `hostname === "::1"`, which never matches because
 * `URL.hostname` keeps the brackets — so `http://[::1]:port` local endpoints
 * (Ollama, LM Studio, MinIO, the local agent) were rejected outright.
 */
const IPV6_LOOPBACK = "http://[::1]:11434";
const PUBLIC_HTTP = "http://provider.example.com";

const template: AiTemplateConfig = {
  method: "POST",
  path: "/v1/chat",
  auth: "bearer",
  request: { prompt: "{{prompt}}" },
  responsePath: "data",
};

describe("loopback URL validators accept bracketed IPv6", () => {
  test("resolveTemplateEndpoint allows http on [::1] and still rejects public http", () => {
    expect(resolveTemplateEndpoint(IPV6_LOOPBACK, template)).toBe("http://[::1]:11434/v1/chat");
    expect(() => resolveTemplateEndpoint(PUBLIC_HTTP, template)).toThrow(/HTTPS/);
  });

  test("joinProviderUrl allows http on [::1] and still rejects public http", () => {
    expect(joinProviderUrl(`${IPV6_LOOPBACK}/v1`, "/chat/completions"))
      .toBe("http://[::1]:11434/v1/chat/completions");
    expect(() => joinProviderUrl(PUBLIC_HTTP, "/chat/completions")).toThrow(/HTTPS/);
  });

  test("normalizeAgentBaseUrl allows http on [::1] and still rejects public http", () => {
    expect(normalizeAgentBaseUrl("http://[::1]:8790")).toBe("http://[::1]:8790");
    expect(() => normalizeAgentBaseUrl(PUBLIC_HTTP)).toThrow(/HTTPS/);
  });

  test("validateObjectStorageConfig allows http on [::1] only when explicitly opted in", () => {
    const base = {
      ...createDefaultObjectStorage(),
      enabled: true,
      endpoint: "http://[::1]:9000",
      bucket: "openboard",
      region: "auto",
      accessKeyId: "key",
      secretAccessKey: "secret",
    };
    expect(validateObjectStorageConfig({ ...base, allowInsecureLoopback: true })).toBeNull();
    expect(validateObjectStorageConfig({ ...base, allowInsecureLoopback: false })).toMatch(/HTTPS/);
    expect(validateObjectStorageConfig({
      ...base,
      endpoint: PUBLIC_HTTP,
      allowInsecureLoopback: true,
    })).toMatch(/HTTPS/);
  });
});
