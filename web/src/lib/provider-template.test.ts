import { describe, expect, test } from "bun:test";

import {
  compileProviderTemplate,
  readTemplatePath,
  resolveTemplateEndpoint,
  validateProviderTemplate,
} from "./provider-template";
import type { AiTemplateConfig } from "@/types/board";

const valid = (): AiTemplateConfig => ({
  method: "POST",
  path: "/jobs",
  auth: "bearer",
  request: { prompt: "{{prompt}}", model: "{{model}}", options: { size: "{{size}}" } },
  responsePath: "data.images",
});

describe("declarative provider templates", () => {
  test("compiles only known exact JSON placeholders without mutating the manifest", () => {
    const template = valid();
    expect(compileProviderTemplate(template, {
      prompt: "red square",
      model: "image-v1",
      size: "1024x1024",
    })).toEqual({ prompt: "red square", model: "image-v1", options: { size: "1024x1024" } });
    expect(template.request.prompt).toBe("{{prompt}}");
  });

  test("rejects scripts, expressions, unsafe paths, URL credentials, and prototype keys", () => {
    expect(() => validateProviderTemplate({ ...valid(), method: "GET" as "POST" })).toThrow("method");
    expect(() => validateProviderTemplate({ ...valid(), path: "https://evil.example/jobs" })).toThrow("relative");
    expect(() => validateProviderTemplate({ ...valid(), path: "/jobs?key={{apiKey}}" })).toThrow("query");
    expect(() => validateProviderTemplate({ ...valid(), responsePath: "data[0].url" })).toThrow("responsePath");
    expect(() => compileProviderTemplate({ ...valid(), request: { value: "{{prompt.toString()}}" } }, {})).toThrow("placeholder");
    expect(() => validateProviderTemplate({ ...valid(), request: JSON.parse('{"__proto__":{"x":1}}') })).toThrow("unsafe");
  });

  test("reads a bounded simple response field path", () => {
    expect(readTemplatePath({ data: { output: ["one"] } }, "data.output")).toEqual(["one"]);
    expect(() => readTemplatePath({ data: {} }, "data.missing")).toThrow("missing");
  });

  test("resolves only credential-free HTTPS or loopback base URLs", () => {
    expect(resolveTemplateEndpoint("https://relay.example/api/", valid())).toBe("https://relay.example/api/jobs");
    expect(() => resolveTemplateEndpoint("https://user:pass@relay.example/api", valid())).toThrow("credentials");
    expect(() => resolveTemplateEndpoint("https://relay.example/api?key=secret", valid())).toThrow("query");
    expect(() => resolveTemplateEndpoint("http://relay.example/api", valid())).toThrow("HTTPS");
    expect(resolveTemplateEndpoint("http://127.0.0.1:9000/api", valid())).toBe("http://127.0.0.1:9000/api/jobs");
  });
});
