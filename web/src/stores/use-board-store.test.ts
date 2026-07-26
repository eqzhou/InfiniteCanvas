import { describe, expect, test } from "bun:test";
import { TenantConfigAdminRequiredError } from "@/services/server-storage";
import { applyGenerationDefaultsToNode, saveWorkspaceReplacementConfig, useBoardStore } from "./use-board-store";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import { createNode, createProject } from "@/lib/defaults";

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

describe("undo scope for the viewport", () => {
	function seedProject(title: string) {
		const project = createProject(title);
		useBoardStore.setState({ projects: [project], activeProjectId: project.id, ready: true });
		return project;
	}

	test("a viewport gesture is its own undo step", () => {
		// Upstream lists the viewport alongside nodes and edges in the undo
		// scope. A gesture writes the viewport on every frame, so the history
		// entry is taken once when the gesture starts — the same coalescing the
		// node drag and corner resize already use.
		seedProject("viewport-undo");
		useBoardStore.getState().addNode("text", { x: 0, y: 0 });
		const start = useBoardStore.getState().projects[0]!.viewport;

		useBoardStore.getState().setViewport({ x: 400, y: 300, k: 1.5 });
		useBoardStore.getState().setViewport({ x: 900, y: 700, k: 2 });
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual({ x: 900, y: 700, k: 2 });
		useBoardStore.getState().commitViewportRun();

		// One undo rewinds the whole gesture, not one frame of it, and leaves
		// the canvas content alone.
		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual(start);
		expect(useBoardStore.getState().projects[0]!.nodes).toHaveLength(1);

		useBoardStore.getState().redo();
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual({ x: 900, y: 700, k: 2 });

		// The node edit underneath is still reachable.
		useBoardStore.getState().undo();
		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.nodes).toHaveLength(0);
	});

	test("a whole gesture collapses into one undo step", () => {
		// A wheel zoom writes the viewport on every animation frame. Without
		// coalescing those frames would evict the 100-entry history and one
		// undo would rewind a single frame instead of the gesture.
		seedProject("viewport-frames");
		const start = useBoardStore.getState().projects[0]!.viewport;
		for (let i = 1; i <= 20; i += 1) {
			useBoardStore.getState().setViewport({ x: i * 10, y: i * 10, k: 1 });
		}
		useBoardStore.getState().commitViewportRun();

		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual(start);
		// Nothing older remains, so a second undo is a no-op rather than a jump.
		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual(start);
	});

	test("a new gesture after committing the previous one is a separate step", () => {
		seedProject("viewport-runs");
		const start = useBoardStore.getState().projects[0]!.viewport;
		useBoardStore.getState().setViewport({ x: 100, y: 100, k: 1 });
		useBoardStore.getState().commitViewportRun();
		useBoardStore.getState().setViewport({ x: 800, y: 800, k: 3 });
		useBoardStore.getState().commitViewportRun();

		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual({ x: 100, y: 100, k: 1 });
		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual(start);
	});

	test("a history-suppressed write does not swallow the next real gesture", () => {
		// Programmatic camera moves (the locate-node animation) opt out of the
		// undo scope with an explicit false. That must not leave a run open, or
		// the user's next pan would silently merge into it and become
		// unundoable.
		seedProject("viewport-suppressed");
		const start = useBoardStore.getState().projects[0]!.viewport;
		useBoardStore.getState().setViewport({ x: 55, y: 66, k: 1 }, false);

		useBoardStore.getState().setViewport({ x: 700, y: 600, k: 2 });
		useBoardStore.getState().commitViewportRun();
		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.viewport).toEqual({ x: 55, y: 66, k: 1 });

		// The suppressed write itself never became a step, so nothing rewinds
		// past it to the original camera.
		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.viewport).not.toEqual(start);
	});

	test("undo still restores everything that is genuinely canvas content", () => {
		seedProject("content-undo");
		useBoardStore.getState().setBackground("grid");
		const id = useBoardStore.getState().addNode("text", { x: 10, y: 20 });
		useBoardStore.getState().setBackground("dots");

		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.backgroundMode).toBe("grid");
		useBoardStore.getState().undo();
		expect(useBoardStore.getState().projects[0]!.nodes.some((n) => n.id === id)).toBe(false);
	});
});
