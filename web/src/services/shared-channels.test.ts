import { describe, expect, test } from "bun:test";
import {
  invalidateSharedChannelCatalog,
	getSharedChannelCatalogSnapshot,
  isServerManagedChannel,
  loadSharedChannelsCached,
  mergeSharedChannelChoices,
	refreshSharedChannelCatalog,
	resetSharedChannelCatalog,
  sharedChannelAsAI,
} from "./shared-channels";
import { createDefaultChannel } from "@/lib/defaults";

describe("shared channel catalog", () => {
  test("creates server-only providers without enabling text or exposing a real key", () => {
    const channel = sharedChannelAsAI({ id: "shared-1", name: "Shared", protocol: "openai", defaultImageModel: "image-1" });
    expect(channel.providers?.image.apiKey).toBe("server-managed");
    expect(channel.providers?.text.apiKey).toBe("");
    expect(JSON.stringify(channel)).not.toContain("sk-");
    expect(isServerManagedChannel(channel, "image")).toBe(true);
  });

  test("publishes the shared models list onto managed providers", () => {
    const channel = sharedChannelAsAI({
      id: "shared-1",
      name: "Shared",
      protocol: "openai",
      defaultImageModel: "image-1",
      models: ["image-1", "video-1"],
    });
    expect(channel.providers?.image.models).toEqual(["image-1", "video-1"]);
    expect(channel.providers?.video.models).toEqual(["image-1", "video-1"]);
  });

  test("personal channel IDs take precedence over ambiguous shared IDs", () => {
    const personal = { ...createDefaultChannel(), id: "same", name: "Personal" };
    const merged = mergeSharedChannelChoices([personal], [{ id: "same", name: "Shared", protocol: "openai" }, { id: "other", name: "Other", protocol: "openai" }]);
    expect(merged.map((item) => item.name)).toEqual(["Personal", "Other"]);
  });

  test("refreshes the shared catalog after a short TTL and explicit invalidation", async () => {
    invalidateSharedChannelCatalog();
    let calls = 0;
    const loader = async () => [{ id: `shared-${++calls}`, name: "Shared", protocol: "openai" as const }];

    expect((await loadSharedChannelsCached(loader, 1_000))[0]?.id).toBe("shared-1");
    expect((await loadSharedChannelsCached(loader, 1_001))[0]?.id).toBe("shared-1");
    expect((await loadSharedChannelsCached(loader, 31_001))[0]?.id).toBe("shared-2");
    invalidateSharedChannelCatalog();
    expect((await loadSharedChannelsCached(loader, 31_002))[0]?.id).toBe("shared-3");
  });

	test("an invalidated in-flight refresh cannot overwrite the newer catalog", async () => {
		invalidateSharedChannelCatalog();
		let releaseOld: ((items: Array<{ id: string; name: string; protocol: "openai" }>) => void) | undefined;
		const old = refreshSharedChannelCatalog(() => new Promise((resolve) => { releaseOld = resolve; }));
		invalidateSharedChannelCatalog();
		await refreshSharedChannelCatalog(async () => [{ id: "new", name: "New", protocol: "openai" }]);
		releaseOld?.([{ id: "old", name: "Old", protocol: "openai" }]);
		await old;
		expect(getSharedChannelCatalogSnapshot().map((item) => item.id)).toEqual(["new"]);
	});

	test("a scope change clears the cached catalog so another tenant never sees it", async () => {
		resetSharedChannelCatalog();
		await refreshSharedChannelCatalog(async () => [{ id: "tenant-a", name: "Tenant A", protocol: "openai" }]);
		expect(getSharedChannelCatalogSnapshot().map((item) => item.id)).toEqual(["tenant-a"]);

		resetSharedChannelCatalog();
		expect(getSharedChannelCatalogSnapshot()).toEqual([]);

		// The next tenant must trigger a fresh load instead of reusing the cached promise.
		let loads = 0;
		const next = await loadSharedChannelsCached(async () => {
			loads += 1;
			return [{ id: "tenant-b", name: "Tenant B", protocol: "openai" as const }];
		}, 1_000);
		expect(loads).toBe(1);
		expect(next.map((item) => item.id)).toEqual(["tenant-b"]);
	});
});
