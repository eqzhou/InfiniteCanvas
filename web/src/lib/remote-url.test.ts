import { describe, expect, test } from "bun:test";

import { normalizeExternalHttpsUrl } from "./remote-url";

describe("external HTTPS URL policy", () => {
  test("accepts a public HTTPS URL including signed query parameters", () => {
    expect(normalizeExternalHttpsUrl("https://cdn.example.com/image.png?sig=abc"))
      .toBe("https://cdn.example.com/image.png?sig=abc");
  });

  test("rejects plaintext, credentials, fragments, and explicit private hosts", () => {
    expect(() => normalizeExternalHttpsUrl("http://cdn.example.com/a")).toThrow("HTTPS");
    expect(() => normalizeExternalHttpsUrl("https://user:pass@cdn.example.com/a")).toThrow("credentials");
    expect(() => normalizeExternalHttpsUrl("https://cdn.example.com/a#secret")).toThrow("fragment");
    for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "172.16.2.3", "192.168.1.2", "169.254.1.1", "service.local"]) {
      expect(() => normalizeExternalHttpsUrl(`https://${host}/a`)).toThrow("private");
    }
  });
});
