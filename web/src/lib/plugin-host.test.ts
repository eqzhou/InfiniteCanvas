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

  test("admits media-bearing payloads that the executor and uploader accept", () => {
    // asset.create/ai.text carry data URLs; the host already ships 8MB data URLs
    // to plugins, so the inbound envelope has to match that budget.
    const dataUrl = `data:image/png;base64,${"A".repeat(512 * 1024)}`;
    const create = {
      type: "openboard:request",
      nonce: "nonce-123",
      pluginId: "example.gallery",
      requestId: "request-2",
      method: "asset.create",
      params: { kind: "image", title: "Render", content: dataUrl },
    };
    expect(parsePluginHostRequest(create, "nonce-123", "example.gallery", ["asset:write"]))
      .toMatchObject({ method: "asset.create" });
  });

  test("keeps the control-plane envelope small", () => {
    const bloated = {
      type: "openboard:request",
      nonce: "nonce-123",
      pluginId: "example.timer",
      requestId: "request-3",
      method: "node.patch",
      params: { state: { blob: "x".repeat(128 * 1024) } },
    };
    expect(() => parsePluginHostRequest(bloated, "nonce-123", "example.timer", ["node:write"]))
      .toThrow("plugin host params");
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
