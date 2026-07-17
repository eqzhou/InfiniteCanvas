import { describe, expect, test } from "bun:test";
import { parsePluginHostRequest, permissionForPluginMethod } from "./plugin-host";

describe("plugin host protocol", () => {
  test("maps every supported host method to an explicit permission", () => {
    expect(permissionForPluginMethod("node.get")).toBe("node:read");
    expect(permissionForPluginMethod("node.patch")).toBe("node:write");
    expect(permissionForPluginMethod("asset.list")).toBe("asset:read");
    expect(permissionForPluginMethod("asset.create")).toBe("asset:write");
    expect(permissionForPluginMethod("ai.text")).toBe("ai:text");
    expect(permissionForPluginMethod("ai.image")).toBe("ai:image");
    expect(permissionForPluginMethod("ai.video")).toBe("ai:video");
    expect(permissionForPluginMethod("panel.setOpen")).toBe("panel:control");
  });

  test("accepts only nonce-bound, permission-approved, bounded requests", () => {
    const request = {
      type: "openboard:request",
      nonce: "nonce-123",
      pluginId: "example.timer",
      requestId: "request-1",
      method: "ai.text",
      params: { prompt: "hello" },
    };
    expect(parsePluginHostRequest(request, "nonce-123", "example.timer", ["ai:text"]))
      .toMatchObject({ requestId: "request-1", method: "ai.text" });
    expect(() => parsePluginHostRequest(request, "nonce-123", "example.timer", []))
      .toThrow("permission");
    expect(() => parsePluginHostRequest({ ...request, method: "shell.exec" }, "nonce-123", "example.timer", ["ai:text"]))
      .toThrow("method");
  });
});
