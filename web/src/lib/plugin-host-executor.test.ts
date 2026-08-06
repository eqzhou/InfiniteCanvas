import { describe, expect, test } from "bun:test";
import { executePluginHostRequest, type PluginHostContext } from "./plugin-host-executor";
import type { PluginHostRequest } from "./plugin-host";

function context(): PluginHostContext {
  return {
    getNode: () => ({ title: "Note", state: { body: "draft" } }),
    patchNode: (patch) => ({ title: patch.title ?? "Note", state: patch.state ?? {} }),
    listAssets: (query) => [{ id: "asset-1", kind: "text", title: query || "Asset", tags: [] }],
    createAsset: (asset) => ({ id: "asset-new", ...asset, tags: asset.tags ?? [] }),
    generateText: async () => ({ text: "generated" }),
    generateImage: async () => ({ images: ["data:image/png;base64,cGl4ZWw="] }),
    generateVideo: async () => ({ id: "task-1", url: "https://cdn.example/video.mp4" }),
    setPanelOpen: (open) => ({ open }),
  };
}

function request(method: PluginHostRequest["method"], params: Record<string, unknown> = {}): PluginHostRequest {
  return { requestId: "request-1", method, params };
}

describe("plugin host executor", () => {
  test("executes node, asset, and panel operations through the host context", async () => {
    expect(await executePluginHostRequest(request("node.get"), context())).toEqual({
      title: "Note",
      state: { body: "draft" },
    });
    expect(await executePluginHostRequest(request("asset.list", { query: "photo" }), context()))
      .toEqual([{ id: "asset-1", kind: "text", title: "photo", tags: [] }]);
    expect(await executePluginHostRequest(request("panel.setOpen", { open: true }), context()))
      .toEqual({ open: true });
  });

  test("proxies AI results without returning provider credentials", async () => {
    const result = await executePluginHostRequest(request("ai.text", { prompt: "hello" }), context());
    expect(result).toEqual({ text: "generated" });
    expect(JSON.stringify(result)).not.toContain("apiKey");
  });

  test("rejects an unimplemented method instead of resolving a silent no-op", async () => {
    // The host replies ok:true with whatever this resolves to, so an
    // unhandled method must throw rather than return undefined.
    const unsupported = { requestId: "request-1", method: "shell.exec", params: {} } as unknown as PluginHostRequest;
    await expect(executePluginHostRequest(unsupported, context())).rejects.toThrow("unsupported");
  });

  test("rejects malformed method parameters before invoking the context", async () => {
    await expect(executePluginHostRequest(request("ai.text", { prompt: "" }), context()))
      .rejects.toThrow("prompt");
    await expect(executePluginHostRequest(request("asset.create", {
      kind: "file",
      title: "bad",
      content: "x",
    }), context())).rejects.toThrow("kind");
  });
});
