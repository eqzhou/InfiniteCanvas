import { describe, expect, test } from "bun:test";

import { normalizeExternalHttpsUrl, normalizeExternalSourceUrl } from "./remote-url";

describe("external HTTPS URL policy", () => {
  test("accepts public HTTPS URLs with non-sensitive query parameters", () => {
    expect(normalizeExternalHttpsUrl("https://cdn.example.com/image.png?page=2"))
      .toBe("https://cdn.example.com/image.png?page=2");
  });

  test("allows signed read-only media URLs but rejects credentials in source configuration", () => {
    const signed = "https://cdn.example.com/image.png?X-Amz-Signature=abc&X-Amz-Expires=60";
    expect(normalizeExternalHttpsUrl(signed)).toBe(signed);
    expect(() => normalizeExternalSourceUrl(signed)).toThrow("credentials");
  });

  test("rejects plaintext, credentials, fragments, and explicit private hosts", () => {
    expect(() => normalizeExternalHttpsUrl("http://cdn.example.com/a")).toThrow("HTTPS");
    expect(() => normalizeExternalHttpsUrl("https://user:pass@cdn.example.com/a")).toThrow("credentials");
    expect(() => normalizeExternalHttpsUrl("https://cdn.example.com/a#secret")).toThrow("fragment");
    for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "172.16.2.3", "192.168.1.2", "169.254.1.1", "service.local"]) {
      expect(() => normalizeExternalHttpsUrl(`https://${host}/a`)).toThrow("private");
    }
    for (const url of [
      "https://[::ffff:127.0.0.1]/a",
      "https://[::ffff:192.168.1.2]/a",
      "https://[::127.0.0.1]/a",
    ]) {
      expect(() => normalizeExternalHttpsUrl(url)).toThrow("private");
    }
    for (const url of [
      "https://cdn.example.com/a?token=secret",
      "https://cdn.example.com/a?X-Amz-Signature=secret",
      "https://cdn.example.com/a?api_key=secret",
    ]) {
      expect(() => normalizeExternalSourceUrl(url)).toThrow("credentials");
    }
  });
});
