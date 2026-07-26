import { describe, expect, test } from "bun:test";
import { TenantConfigAdminRequiredError } from "@/services/server-storage";
import { applyGenerationDefaultsToNode, saveWorkspaceReplacementConfig } from "./use-board-store";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import { createNode } from "@/lib/defaults";

describe("workspace replacement permissions", () => {
	test("keeps the current tenant config when a member restores a workspace", async () => {
		expect(await saveWorkspaceReplacementConfig(async () => {
			throw new TenantConfigAdminRequiredError();
		})).toBe(false);
	});

	test("does not hide unrelated persistence failures", async () => {
		await expect(saveWorkspaceReplacementConfig(async () => {
			throw new Error("storage offline");
		})).rejects.toThrow("storage offline");
	});
});

describe("generation defaults inheritance", () => {
	const defaults = {
		...DEFAULT_GENERATION_DEFAULTS,
		videoRatio: "9:16",
		videoResolution: "1080p",
		videoSeconds: 12,
		videoGenerateAudio: true,
		videoWatermark: true,
		audioVoice: "verse",
		audioFormat: "wav",
		audioSpeed: 1.25,
		audioInstructions: "轻快地朗读",
	};

	test("seeds new video and audio nodes from the configured defaults", () => {
		const video = applyGenerationDefaultsToNode(createNode("video", { x: 0, y: 0 }), defaults);
		expect(video.metadata).toMatchObject({
			videoRatio: "9:16", resolution: "1080p", seconds: 12,
			generateAudio: true, watermark: true,
		});
		const audio = applyGenerationDefaultsToNode(createNode("audio", { x: 0, y: 0 }), defaults);
		expect(audio.metadata).toMatchObject({ voice: "verse" });
	});

	test("never overrides values the caller already supplied", () => {
		const explicit = createNode("video", { x: 0, y: 0 }, { metadata: { videoRatio: "1:1", seconds: 4 } });
		const seeded = applyGenerationDefaultsToNode(explicit, defaults);
		expect(seeded.metadata.videoRatio).toBe("1:1");
		expect(seeded.metadata.seconds).toBe(4);
		// Unspecified fields still inherit.
		expect(seeded.metadata.resolution).toBe("1080p");
	});

	test("leaves unrelated node types and inputs untouched", () => {
		const text = createNode("text", { x: 0, y: 0 });
		expect(applyGenerationDefaultsToNode(text, defaults)).toBe(text);
		const video = createNode("video", { x: 0, y: 0 });
		const before = JSON.stringify(video);
		applyGenerationDefaultsToNode(video, defaults);
		expect(JSON.stringify(video)).toBe(before);
	});
});
