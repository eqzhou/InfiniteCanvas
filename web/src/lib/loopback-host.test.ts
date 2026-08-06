import { describe, expect, test } from "bun:test";

import { isLoopbackHostname, isLoopbackUrl } from "./loopback-host";

describe("loopback host detection", () => {
  test("recognises the bracketed IPv6 literal the URL parser actually produces", () => {
    // new URL("http://[::1]/").hostname keeps the brackets, so a bare "::1"
    // comparison never matches a real IPv6 loopback URL.
    expect(new URL("http://[::1]:11434/v1").hostname).toBe("[::1]");
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  test("recognises the IPv4 and named loopback forms", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LocalHost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.1.2.3")).toBe(true);
    expect(isLoopbackHostname("[0:0:0:0:0:0:0:1]")).toBe(true);
  });

  test("rejects hosts that merely look local", () => {
    for (const hostname of [
      "example.com",
      "127.0.0.1.example.com",
      "localhost.example.com",
      "10.0.0.1",
      "192.168.1.10",
      "0.0.0.0",
      "[::]",
      "[fd00::1]",
      "",
    ]) {
      expect(isLoopbackHostname(hostname)).toBe(false);
    }
  });

  test("accepts a URL or a string and never throws on malformed input", () => {
    expect(isLoopbackUrl("http://[::1]:8790/")).toBe(true);
    expect(isLoopbackUrl(new URL("https://localhost/v1"))).toBe(true);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
