import { describe, expect, test } from "bun:test";
import {
  fetchPluginManifest,
  installPluginManifest,
  normalizePluginManifests,
  uninstallPluginManifest,
} from "./plugin-catalog";

const manifest = (version = "1.0.0") => ({
  schemaVersion: 1 as const,
  id: "example.timer",
  name: "Timer",
  version,
  description: "A small timer",
  document: "<script>openboard.ready()</script>",
  permissions: ["node:read" as const],
  defaultSize: { width: 320, height: 220 },
});

describe("plugin catalog", () => {
  test("installs a new manifest immutably and upgrades by id", () => {
    const original = [manifest()];
    expect(() => installPluginManifest(original, manifest())).toThrow("already installed");

    const upgraded = installPluginManifest(original, manifest("1.1.0"));
    expect(upgraded).toEqual([manifest("1.1.0")]);
    expect(original).toEqual([manifest()]);
  });

  test("uninstalls by id without mutating the input", () => {
    const original = [manifest()];
    expect(uninstallPluginManifest(original, "example.timer")).toEqual([]);
    expect(original).toHaveLength(1);
  });

  test("normalizes persisted manifests and discards malformed entries", () => {
    expect(normalizePluginManifests([
      manifest(),
      { ...manifest("1.1.0") },
      { ...manifest(), id: "../bad" },
      null,
    ])).toEqual([manifest("1.1.0")]);
    expect(normalizePluginManifests({})).toEqual([]);
  });

  test("fetches only bounded HTTPS manifests without following redirects", async () => {
    let redirect: RequestRedirect | undefined;
    const fetched = await fetchPluginManifest(
      "https://plugins.example/timer.json",
      async (_input, init) => {
        redirect = init?.redirect;
        return new Response(JSON.stringify(manifest()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(fetched.id).toBe("example.timer");
    expect(redirect).toBe("manual");

    await expect(fetchPluginManifest("http://plugins.example/timer.json")).rejects.toThrow("HTTPS");
    await expect(fetchPluginManifest("https://user:pass@plugins.example/timer.json")).rejects.toThrow("credentials");
  });

  test("rejects redirects, wrong content types, and oversized streamed bodies", async () => {
    await expect(fetchPluginManifest("https://plugins.example/a", async () =>
      new Response(null, { status: 302, headers: { location: "https://plugins.example/b" } }),
    )).rejects.toThrow("redirect");

    await expect(fetchPluginManifest("https://plugins.example/a", async () =>
      new Response("not json", { headers: { "content-type": "text/html" } }),
    )).rejects.toThrow("JSON");

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(400_000));
        controller.enqueue(new Uint8Array(400_000));
        controller.close();
      },
    });
    await expect(fetchPluginManifest("https://plugins.example/a", async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
    )).rejects.toThrow("too large");
  });
});
