import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "@/lib/defaults";
import {
  comparePluginVersions,
  enabledPluginManifests,
  fetchPluginRegistry,
  fetchPluginManifest,
  installPluginManifest,
  normalizePluginManifests,
  persistPluginConfigChange,
  persistPluginUpgrade,
  setPluginEnabled,
  uninstallPluginManifest,
} from "./plugin-catalog";

const manifest = (version = "1.0.0") => ({
  schemaVersion: 2 as const,
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
    expect(() => installPluginManifest(upgraded, manifest("1.0.0"))).toThrow("downgraded");
  });

  test("compares semantic versions for update notices", () => {
    expect(comparePluginVersions("1.10.0", "1.2.9")).toBeGreaterThan(0);
    expect(comparePluginVersions("2.0.0-beta.1", "2.0.0")).toBeLessThan(0);
    expect(comparePluginVersions("2.0.0", "2.0.0")).toBe(0);
  });

  test("rolls an upgrade back when persistence fails", async () => {
    const original = [manifest()];
    const writes: unknown[] = [];
    await expect(persistPluginUpgrade(original, manifest("1.1.0"), async (plugins) => {
      writes.push(plugins);
      if (writes.length === 1) throw new Error("disk full");
    })).rejects.toThrow("disk full");
    expect(writes).toEqual([[manifest("1.1.0")], original]);
    expect(original).toEqual([manifest()]);
  });

  test("rolls a full plugin configuration change back when persistence fails", async () => {
    const current = {
      ...createDefaultConfig(),
      plugins: [manifest()],
      disabledPluginIds: [],
    };
    const next = { ...current, plugins: [manifest("1.1.0")] };
    const writes: unknown[] = [];

    await expect(persistPluginConfigChange(current, next, async (config) => {
      writes.push(config);
      if (writes.length === 1) throw new Error("disk full");
    })).rejects.toThrow("disk full");
    expect(writes).toEqual([next, current]);
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

  test("filters disabled plugins without mutating persisted inputs", () => {
    const installed = [manifest(), { ...manifest(), id: "example.clock", name: "Clock" }];
    const disabled = ["example.clock"];
    expect(enabledPluginManifests(installed, disabled).map((item) => item.id))
      .toEqual(["example.timer"]);
    expect(setPluginEnabled(disabled, "example.clock", true)).toEqual([]);
    expect(setPluginEnabled(disabled, "example.timer", false))
      .toEqual(["example.clock", "example.timer"]);
    expect(installed).toHaveLength(2);
    expect(disabled).toEqual(["example.clock"]);
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

  test("fetches an independent bounded registry and validates manifest URLs", async () => {
    const registry = await fetchPluginRegistry("https://registry.openboard.local/index.json", async () =>
      new Response(JSON.stringify({
        schemaVersion: 1,
        plugins: [{
          id: "example.timer",
          name: "Timer",
          version: "1.2.0",
          manifestUrl: "https://plugins.example/timer.json",
          description: "A small timer",
        }],
      }), { headers: { "content-type": "application/json" } }),
    );
    expect(registry.plugins[0]?.manifestUrl).toBe("https://plugins.example/timer.json");
    await expect(fetchPluginRegistry("http://registry.example/index.json")).rejects.toThrow("HTTPS");
  });
});
