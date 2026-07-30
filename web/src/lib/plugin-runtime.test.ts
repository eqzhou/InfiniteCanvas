import { describe, expect, test } from "bun:test";
import {
  buildPluginDocument,
  isPluginReadyMessage,
  parsePluginManifest,
  parsePluginPatchMessage,
} from "./plugin-runtime";

const manifest = () => ({
  schemaVersion: 2,
  id: "example.sticky-note",
  name: "Sticky Note",
  version: "1.0.0",
  description: "A note node",
  document: "<main id='note'></main><script>openboard.ready()</script>",
  permissions: ["node:read", "node:write"],
  defaultSize: { width: 320, height: 220 },
});

describe("plugin runtime boundary", () => {
  test("accepts a bounded declarative manifest", () => {
    const parsed = parsePluginManifest(manifest());
    expect(parsed.id).toBe("example.sticky-note");
    expect(parsed.permissions).toEqual(["node:read", "node:write"]);
  });

  test("normalizes legacy v1 manifests to v2 without changing executable content", () => {
    const legacy = { ...manifest(), schemaVersion: 1 };
    const parsed = parsePluginManifest(legacy);
    expect(parsed).toEqual({ ...legacy, schemaVersion: 2 });
  });

  test("accepts every v2 host permission and deduplicates consent entries", () => {
    const permissions = [
      "node:read", "node:write", "asset:read", "asset:write",
      "ai:text", "ai:image", "ai:video", "panel:control", "ai:text",
    ];
    expect(parsePluginManifest({ ...manifest(), permissions }).permissions).toEqual(
      permissions.slice(0, -1),
    );
  });

  test("rejects unknown permissions, identifiers, and oversized documents", () => {
    expect(() => parsePluginManifest({ ...manifest(), id: "../escape" })).toThrow("id");
    expect(() => parsePluginManifest({ ...manifest(), permissions: ["filesystem:read"] })).toThrow("permission");
    expect(() => parsePluginManifest({ ...manifest(), document: "x".repeat(512_001) })).toThrow("document");
  });

  test("builds an opaque-frame document with a network-denying CSP", () => {
    const document = buildPluginDocument(parsePluginManifest(manifest()), "nonce-123");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("nonce-123");
    expect(document).toContain("setInterval(announceReady,50)");
    expect(document).toContain("ready:function(){if(initialized)return;announceReady()");
    expect(document).not.toContain("allow-same-origin");
  });

  test("accepts only nonce-bound, size-limited patch messages", () => {
    expect(parsePluginPatchMessage({
      type: "openboard:patch",
      nonce: "nonce-123",
      patch: { title: "Updated", state: { body: "hello" } },
    }, "nonce-123")).toEqual({ title: "Updated", state: { body: "hello" } });
    expect(() => parsePluginPatchMessage({
      type: "openboard:patch",
      nonce: "wrong",
      patch: { title: "x" },
    }, "nonce-123")).toThrow("nonce");
    expect(() => parsePluginPatchMessage({
      type: "openboard:patch",
      nonce: "nonce-123",
      patch: { width: 999 },
    }, "nonce-123")).toThrow("field");
    expect(() => parsePluginPatchMessage({
      type: "openboard:patch",
      nonce: "nonce-123",
      patch: { state: { constructor: { polluted: true } } },
    }, "nonce-123")).toThrow("unsafe key");
    expect(() => parsePluginPatchMessage({
      type: "openboard:patch",
      nonce: "nonce-123",
      pluginId: "other.plugin",
      patch: { title: "x" },
    }, "nonce-123", "example.sticky-note")).toThrow("plugin id");
  });

  test("recognizes ready messages only for the expected plugin identity", () => {
    expect(isPluginReadyMessage({
      type: "openboard:ready",
      nonce: "nonce-123",
      pluginId: "example.sticky-note",
    }, "nonce-123", "example.sticky-note")).toBe(true);
    expect(isPluginReadyMessage({
      type: "openboard:ready",
      nonce: "wrong",
      pluginId: "example.sticky-note",
    }, "nonce-123", "example.sticky-note")).toBe(false);
  });
});
