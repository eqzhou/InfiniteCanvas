import { afterEach, describe, expect, test } from "bun:test";
import { SecretAuthRequiredError, TenantConfigAdminRequiredError } from "@/services/server-storage";
import {
	adoptCommittedProject,
	adoptCommittedWorkspace,
	applyGenerationDefaultsToNode,
	attachUploadedAudio,
	attachUploadedImage,
	attachUploadedVideo,
	ensureChatSession,
	ProjectCommitRollbackError,
	removeDirectorShotPlan,
	saveWorkspaceReplacementConfig,
	useBoardStore,
} from "./use-board-store";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import { createDefaultConfig, createNode, createProject } from "@/lib/defaults";
import type { AssetItem, BoardProject, PromptItem } from "@/types/board";

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; method: string; body: string | undefined }> = [];

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function installFetch(
	responder: (url: string, init: RequestInit) => Response | Promise<Response> = (url, init) => {
		if (url.includes("/generation-jobs?") && (init.method ?? "GET") === "GET") {
			return jsonResponse({ items: [], page: 1, pageSize: 100, total: 0 });
		}
		if (url.endsWith("/state/assets") || url.endsWith("/state/prompts")) {
			return (init.method ?? "GET") === "GET" ? jsonResponse([]) : new Response(null, { status: 204 });
		}
		if (url.endsWith("/config") && (init.method ?? "GET") === "GET") return new Response(null, { status: 404 });
		if (url.endsWith("/config") && init.method === "PUT") {
			return new Response(null, { status: 200, headers: { ETag: '"test-config"' } });
		}
		return new Response(null, { status: 204 });
	},
): void {
	fetchCalls = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		fetchCalls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
		return responder(url, init);
	}) as typeof fetch;
}

function seedProject(
	title = "test project",
	state: "idle" | "loaded" = "idle",
): BoardProject {
	const project = createProject(title);
	useBoardStore.setState({
		ready: true,
		projectsState: state,
		assetsState: state,
		promptsState: state,
		projects: [project],
		activeProjectId: project.id,
		selectedIds: [],
		clipboard: null,
		config: createDefaultConfig(),
		assets: [],
		prompts: [],
		connectingFrom: null,
		projectsError: null,
		assetsError: null,
		promptsError: null,
	});
	return project;
}

function activeProject(): BoardProject {
	const project = useBoardStore.getState().getActive();
	if (!project) throw new Error("expected an active project");
	return project;
}

afterEach(async () => {
	// Let fire-and-forget autosaves finish while their test fetch is still installed.
	await Promise.resolve();
	await Promise.resolve();
	globalThis.fetch = originalFetch;
});

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

describe("director formal shot rollback", () => {
	test("removes only the planned chain and preserves concurrent canvas edits", () => {
		const project = createProject("director rollback");
		const director = createNode("director", { x: 0, y: 0 });
		const capture = createNode("image", { x: 100, y: 0 });
		const config = createNode("config", { x: 200, y: 0 });
		const result = createNode("image", { x: 300, y: 0 });
		const concurrent = createNode("text", { x: 0, y: 200 });
		project.nodes = [director, capture, config, result, concurrent];
		project.edges = [
			{ id: "edge-shot-1", from: director.id, to: capture.id },
			{ id: "edge-shot-2", from: capture.id, to: config.id },
			{ id: "edge-shot-3", from: config.id, to: result.id },
			{ id: "edge-concurrent", from: director.id, to: concurrent.id },
		];

		const rolledBack = removeDirectorShotPlan(
			project,
			new Set([capture.id, config.id, result.id]),
			new Set(["edge-shot-1", "edge-shot-2", "edge-shot-3"]),
		);

		expect(rolledBack.nodes.map((node) => node.id)).toEqual([director.id, concurrent.id]);
		expect(rolledBack.edges).toEqual([{ id: "edge-concurrent", from: director.id, to: concurrent.id }]);
		expect(project.nodes).toHaveLength(5);
	});
});

describe("project and canvas editing behavior", () => {
	test("creates, renames, imports, activates, and exports projects without mutating the source", () => {
		installFetch();
		useBoardStore.setState({
			ready: true,
			projectsState: "loaded",
			projects: [],
			activeProjectId: null,
			selectedIds: [],
		});

		const id = useBoardStore.getState().createProject("first", "film");
		const first = activeProject();
		expect(first.title).toBe("first");
		expect(first.projectKind).toBe("film");
		expect(useBoardStore.getState().selectedIds).toEqual([]);

		useBoardStore.getState().renameProject(id, "renamed");
		expect(activeProject().title).toBe("renamed");

		const source = createProject("source");
		const sourceBefore = structuredClone(source);
		const importedId = useBoardStore.getState().importProject(source);
		const imported = useBoardStore.getState().projects.find((project) => project.id === importedId);
		expect(imported).toMatchObject({ id: importedId, title: "source (导入)", projectKind: "canvas" });
		expect(source).toEqual(sourceBefore);
		expect(useBoardStore.getState().activeProjectId).toBe(importedId);

		useBoardStore.getState().setActiveProject(id);
		expect(useBoardStore.getState().activeProjectId).toBe(id);
		expect(useBoardStore.getState().exportActiveProject()).toBe(useBoardStore.getState().projects[1]);
	});

	test("deletes unique projects durably and chooses a surviving active project", async () => {
		installFetch();
		const first = seedProject("first", "loaded");
		const second = createProject("second");
		useBoardStore.setState({ projects: [first, second], activeProjectId: first.id });

		await useBoardStore.getState().deleteProjectsDurably([first.id, first.id, ""]);

		expect(useBoardStore.getState().projects.map((project) => project.id)).toEqual([second.id]);
		expect(useBoardStore.getState().activeProjectId).toBe(second.id);
		expect(fetchCalls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
			`/api/projects/${first.id}`,
			`/api/generation-jobs/project/${first.id}`,
		]);
	});

	test("adds connected nodes, merges metadata patches, moves, and clamps resize dimensions", () => {
		const project = seedProject();
		const root = useBoardStore.getState().addNode("text", { x: 10, y: 20 }, {
			title: "root",
			metadata: { content: "original", fontSize: 20 },
		});
		const rootBefore = structuredClone(activeProject().nodes[0]);
		const child = useBoardStore.getState().addConnectedNode("missing", "image", { x: 100, y: 100 });
		expect(child).toBeNull();
		expect(activeProject().nodes).toHaveLength(1);

		const connected = useBoardStore.getState().addConnectedNode(root, "image", { x: 100, y: 100 });
		expect(connected).toBeString();
		expect(activeProject().edges).toHaveLength(1);
		expect(activeProject().edges[0]).toMatchObject({ from: root, to: connected! });

		useBoardStore.getState().updateNode(root, { title: "updated", metadata: { fontSize: 30 } });
		const updated = activeProject().nodes.find((node) => node.id === root)!;
		expect(updated).toMatchObject({ title: "updated", metadata: { content: "original", fontSize: 30 } });
		useBoardStore.getState().updateNode(root, (node) => ({ ...node, position: { x: 3, y: 4 } }));
		useBoardStore.getState().moveNodes([root, connected!], 5, -10);
		useBoardStore.getState().resizeNode(root, 20, 30, { x: 50, y: 60 });
		const moved = activeProject().nodes.find((node) => node.id === root)!;
		expect(moved.position).toEqual({ x: 50, y: 60 });
		expect(moved.width).toBe(120);
		expect(moved.height).toBe(80);
		expect(rootBefore).not.toEqual(moved);
		expect(activeProject().nodes.find((node) => node.id === connected!)?.position).toEqual({ x: 105, y: 90 });
		void project;
	});

	test("deduplicates and removes edges while preserving connecting state", () => {
		const project = seedProject();
		const from = useBoardStore.getState().addNode("text", { x: 0, y: 0 });
		const to = useBoardStore.getState().addNode("image", { x: 200, y: 0 });
		useBoardStore.getState().setConnectingFrom(from);
		useBoardStore.getState().connect(from, from);
		expect(activeProject().edges).toHaveLength(0);
		expect(useBoardStore.getState().connectingFrom).toBe(from);

		useBoardStore.getState().connect(from, to);
		useBoardStore.getState().connect(from, to);
		expect(activeProject().edges).toHaveLength(1);
		expect(useBoardStore.getState().connectingFrom).toBeNull();
		const edgeId = activeProject().edges[0]!.id;
		useBoardStore.getState().deleteEdge(edgeId);
		expect(activeProject().edges).toEqual([]);
		expect(project.nodes).toHaveLength(0);
	});

	test("copies selected subgraphs with fresh ids and offset positions", () => {
		seedProject();
		const from = useBoardStore.getState().addNode("text", { x: 10, y: 20 });
		const to = useBoardStore.getState().addConnectedNode(from, "image", { x: 100, y: 200 })!;
		const original = structuredClone(activeProject());
		useBoardStore.getState().setSelected([from, to]);
		useBoardStore.getState().copySelected();
		const clipboard = useBoardStore.getState().clipboard!;
		expect(clipboard.nodes.map((node) => node.id)).toEqual([from, to]);
		useBoardStore.getState().pasteClipboard({ x: 7, y: 9 });

		const current = activeProject();
		const pastedIds = useBoardStore.getState().selectedIds;
		expect(pastedIds).toHaveLength(2);
		expect(pastedIds.every((id) => ![from, to].includes(id))).toBe(true);
		expect(current.nodes).toHaveLength(original.nodes.length + 2);
		expect(current.edges).toHaveLength(original.edges.length + 1);
		expect(current.nodes.find((node) => node.id === pastedIds[0])?.position).toEqual({ x: 17, y: 29 });
		expect(current.edges.some((edge) => edge.from === pastedIds[0] && edge.to === pastedIds[1])).toBe(true);
		expect(useBoardStore.getState().clipboard).toEqual(clipboard);

		useBoardStore.getState().duplicateSelected();
		expect(activeProject().nodes).toHaveLength(original.nodes.length + 4);
	});

	test("aligns, distributes, groups, and ungroups selected nodes", () => {
		seedProject();
		const a = useBoardStore.getState().addNode("text", { x: 0, y: 0 });
		const b = useBoardStore.getState().addNode("text", { x: 200, y: 80 });
		const c = useBoardStore.getState().addNode("text", { x: 500, y: 200 });
		useBoardStore.getState().setSelected([a, b, c]);
		useBoardStore.getState().alignSelected("top");
		expect(new Set([a, b, c].map((id) => activeProject().nodes.find((node) => node.id === id)!.position.y)).size).toBe(1);
		useBoardStore.getState().distributeSelected("x");
		const positions = [a, b, c].map((id) => activeProject().nodes.find((node) => node.id === id)!.position.x);
		expect(positions[1]! - positions[0]!).toBe(positions[2]! - positions[1]!);

		useBoardStore.getState().groupSelected();
		const groupId = useBoardStore.getState().selectedIds[0]!;
		const group = activeProject().nodes.find((node) => node.id === groupId)!;
		expect(group.type).toBe("group");
		expect(group.metadata.childIds).toEqual(expect.arrayContaining([a, b, c]));
		useBoardStore.getState().ungroupSelected();
		expect(activeProject().nodes.some((node) => node.id === groupId)).toBe(false);
		expect(useBoardStore.getState().selectedIds).toEqual(expect.arrayContaining([a, b, c]));
	});

	test("cascades batch-root deletion and repairs remaining metadata", () => {
		installFetch();
		seedProject();
		const child = createNode("image", { x: 100, y: 0 }, {
			id: "batch-child",
			metadata: { batchRootId: "batch-root", content: "child" },
		});
		const root = createNode("image", { x: 0, y: 0 }, {
			id: "batch-root",
			metadata: { isBatchRoot: true, batchChildIds: [child.id], primaryImageId: child.id },
		});
		const survivor = createNode("text", { x: 300, y: 0 });
		useBoardStore.setState({
			projects: [{ ...activeProject(), nodes: [root, child, survivor], edges: [
				{ id: "batch-edge", from: root.id, to: child.id },
				{ id: "survivor-edge", from: root.id, to: survivor.id },
			] }],
			selectedIds: [root.id],
		});

		useBoardStore.getState().deleteSelected();
		expect(activeProject().nodes.map((node) => node.id)).toEqual([survivor.id]);
		expect(activeProject().edges).toEqual([]);
		expect(useBoardStore.getState().selectedIds).toEqual([]);
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

describe("lazy workspace writes", () => {
	test("does not create or import a project before the catalog is loaded", () => {
		useBoardStore.setState({ projects: [], activeProjectId: null, projectsState: "idle" });
		expect(() => useBoardStore.getState().createProject("too soon")).toThrow("项目尚未加载完成");
		expect(() => useBoardStore.getState().importProject(createProject("imported"))).toThrow("项目尚未加载完成");
	});

	test("does not keep an in-memory catalog when persist is refused", () => {
		useBoardStore.setState({ assets: [], assetsState: "idle", prompts: [], promptsState: "idle" });
		useBoardStore.getState().setAssets([{
			id: "asset-1", kind: "text", title: "ghost", tags: [], createdAt: "t", updatedAt: "t",
		}]);
		useBoardStore.getState().setPrompts([{ id: "p1", title: "ghost", body: "x", tags: [], source: "local" }]);
		expect(useBoardStore.getState().assets).toEqual([]);
		expect(useBoardStore.getState().prompts).toEqual([]);
	});

	test("marks restored workspace catalogs as loaded", () => {
		useBoardStore.setState({
			projectsState: "idle",
			assetsState: "idle",
			promptsState: "idle",
			projects: [],
			assets: [],
			prompts: [],
		});
		const project = createProject("restored");
		adoptCommittedWorkspace({
			projects: [project],
			assets: [],
			prompts: [],
			config: useBoardStore.getState().config,
			generationJobs: [],
			workflowTemplates: [],
		});
		expect(useBoardStore.getState().projectsState).toBe("loaded");
		expect(useBoardStore.getState().assetsState).toBe("loaded");
		expect(useBoardStore.getState().promptsState).toBe("loaded");
		expect(useBoardStore.getState().projects[0]?.id).toBe(project.id);
	});
});

describe("workspace catalog loading boundaries", () => {
	test("hydrates config once per scope and normalizes the loaded value", async () => {
		installFetch((url, init) => {
			if (url.endsWith("/config") && (init.method ?? "GET") === "GET") {
				const config = createDefaultConfig();
				config.systemPrompt = "loaded prompt";
				config.disabledPluginIds = ["plugin-a", "plugin-a"];
				return jsonResponse({ config, secrets: {
					apiKeys: {}, webdavPass: "", objectStorageAccessKeyId: "",
					objectStorageSecretAccessKey: "", objectStorageSessionToken: "",
				} }, 200, { ETag: '"hydrate-v1"' });
			}
			return new Response(null, { status: 204 });
		});
		const scope = `hydrate-${crypto.randomUUID()}`;
		const first = useBoardStore.getState().hydrate(scope);
		const second = useBoardStore.getState().hydrate(scope);
		expect(first).toBe(second);
		await first;
		expect(useBoardStore.getState().ready).toBe(true);
		expect(useBoardStore.getState().config.systemPrompt).toBe("loaded prompt");
		expect(useBoardStore.getState().config.disabledPluginIds).toEqual(["plugin-a"]);
		expect(fetchCalls.filter((call) => call.url.endsWith("/config"))).toHaveLength(1);
	});

	test("keeps the app usable with default config when hydration fails", async () => {
		installFetch(async (url) => {
			if (url.endsWith("/config")) throw new Error("config offline");
			return new Response(null, { status: 204 });
		});
		await useBoardStore.getState().hydrate(`hydrate-error-${crypto.randomUUID()}`);
		expect(useBoardStore.getState().ready).toBe(true);
		expect(useBoardStore.getState().config.channels.length).toBeGreaterThan(0);
	});

	test("loads a project catalog, rehydrates it, and creates a default when empty", async () => {
		const project = createProject("from server");
		let returnEmpty = false;
		installFetch((url, init) => {
			if (url.endsWith("/projects") && (init.method ?? "GET") === "GET") {
				return jsonResponse(returnEmpty ? [] : [{ id: project.id }]);
			}
			if (url.endsWith(`/projects/${project.id}`)) return jsonResponse(project);
			return new Response(null, { status: 204 });
		});
		useBoardStore.setState({ ready: true, projectsState: "idle", projects: [], activeProjectId: null });
		await useBoardStore.getState().loadProjectsOnDemand();
		expect(useBoardStore.getState().projectsState).toBe("loaded");
		expect(useBoardStore.getState().projects[0]).toMatchObject({ id: project.id, title: "from server" });

		returnEmpty = true;
		useBoardStore.setState({ projectsState: "idle", projects: [], activeProjectId: null });
		await useBoardStore.getState().loadProjectsOnDemand();
		expect(useBoardStore.getState().projects).toHaveLength(1);
		expect(useBoardStore.getState().projects[0]?.title).toBe("我的第一个画布");
	});

	test("deduplicates concurrent project loads and exposes load failures", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const project = createProject("concurrent");
		installFetch(async (url, init) => {
			if (url.endsWith("/projects") && (init.method ?? "GET") === "GET") {
				await gate;
				return jsonResponse([{ id: project.id }]);
			}
			if (url.endsWith(`/projects/${project.id}`)) return jsonResponse(project);
			return new Response(null, { status: 204 });
		});
		useBoardStore.setState({ projectsState: "idle", projects: [], activeProjectId: null });
		const first = useBoardStore.getState().loadProjectsOnDemand();
		const second = useBoardStore.getState().loadProjectsOnDemand();
		expect(first).toBe(second);
		await Promise.resolve();
		expect(fetchCalls.filter((call) => call.url.endsWith("/projects"))).toHaveLength(1);
		release();
		await first;

		installFetch(async (url) => {
			if (url.endsWith("/projects")) throw new Error("project catalog offline");
			return new Response(null, { status: 204 });
		});
		useBoardStore.setState({ projectsState: "idle", projects: [], activeProjectId: null });
		await expect(useBoardStore.getState().loadProjectsOnDemand()).rejects.toThrow("project catalog offline");
		expect(useBoardStore.getState().projectsState).toBe("error");
		expect(useBoardStore.getState().projectsError).toBe("project catalog offline");
	});

	test("loads assets and prompts only after their catalogs are requested", async () => {
		const asset: AssetItem = {
			id: "asset-server", kind: "text", title: "server asset", tags: [], content: "hello",
			createdAt: "2026-01-01", updatedAt: "2026-01-01",
		};
		const personal: PromptItem = { id: "personal", title: "Personal", body: "body", tags: ["mine"], source: "local" };
		installFetch((url, init) => {
			if (url.endsWith("/config")) return jsonResponse({ config: createDefaultConfig(), secrets: {
				apiKeys: {}, webdavPass: "", objectStorageAccessKeyId: "",
				objectStorageSecretAccessKey: "", objectStorageSessionToken: "",
			} }, 200, { ETag: '"catalog-config"' });
			if (url.endsWith("/state/assets") && (init.method ?? "GET") === "GET") return jsonResponse([asset]);
			if (url.endsWith("/state/prompts") && (init.method ?? "GET") === "GET") return jsonResponse([personal]);
			if (url.endsWith("/prompt-catalog")) {
				return jsonResponse({
					version: 1, revision: 4, categories: [{ id: "general", name: "General", order: 1 }],
					prompts: [{ id: "shared", title: "Shared", body: "shared body", tags: ["team"] }],
				});
			}
			return new Response(null, { status: 204 });
		});
		await useBoardStore.getState().hydrate(`catalog-${crypto.randomUUID()}`);
		await useBoardStore.getState().loadAssetsOnDemand();
		expect(useBoardStore.getState().assetsState).toBe("loaded");
		expect(useBoardStore.getState().assets).toEqual([asset]);

		await useBoardStore.getState().loadPromptsOnDemand();
		expect(useBoardStore.getState().promptsState).toBe("loaded");
		expect(useBoardStore.getState().prompts).toEqual([
			personal,
			{ id: "catalog:shared", title: "Shared", body: "shared body", tags: ["team"], source: "团队提示词库", sourceId: "server-public-prompt-catalog" },
		]);
	});

	test("reports asset and prompt load failures without replacing the previous state", async () => {
		installFetch(async (url) => {
			if (url.endsWith("/state/assets")) throw new Error("asset catalog offline");
			if (url.endsWith("/state/prompts")) throw new Error("prompt catalog offline");
			return new Response(null, { status: 204 });
		});
		const oldAsset: AssetItem = { id: "old", kind: "text", title: "old", tags: [], createdAt: "t", updatedAt: "t" };
		const oldPrompt: PromptItem = { id: "old-prompt", title: "old", body: "old", tags: [], source: "local" };
		useBoardStore.setState({
			assetsState: "idle", assets: [oldAsset],
			promptsState: "idle", prompts: [oldPrompt],
		});
		await expect(useBoardStore.getState().loadAssetsOnDemand()).rejects.toThrow("asset catalog offline");
		await expect(useBoardStore.getState().loadPromptsOnDemand()).rejects.toThrow("prompt catalog offline");
		expect(useBoardStore.getState().assetsState).toBe("error");
		expect(useBoardStore.getState().assets).toEqual([oldAsset]);
		expect(useBoardStore.getState().promptsState).toBe("error");
		expect(useBoardStore.getState().prompts).toEqual([oldPrompt]);
	});
});

describe("canvas persistence and catalog updates", () => {
	test("keeps local assets after a failed save and recovers on the next flush", async () => {
		let fail = true;
		installFetch((url, init) => {
			if (url.endsWith("/state/assets") && init.method === "PUT" && fail) {
				return new Response("asset storage offline", { status: 503 });
			}
			return new Response(null, { status: 204 });
		});
		seedProject("assets", "loaded");
		const first: AssetItem = { id: "a1", kind: "text", title: "first", tags: [], createdAt: "t", updatedAt: "t" };
		useBoardStore.getState().setAssets([first]);
		await expect(useBoardStore.getState().flushAssets()).rejects.toThrow("State save failed: HTTP 503");
		expect(useBoardStore.getState().assets).toEqual([first]);

		fail = false;
		const second = { ...first, id: "a2", title: "second" };
		useBoardStore.getState().setAssets([first, second]);
		await useBoardStore.getState().flushAssets();
		expect(fetchCalls.filter((call) => call.url.endsWith("/state/assets") && call.method === "PUT")).toHaveLength(2);
	});

	test("persists only the latest prompt catalog and strips public entries", async () => {
		installFetch();
		seedProject("prompts", "loaded");
		const personal: PromptItem = { id: "p1", title: "Personal", body: "one", tags: [], source: "local" };
		const shared: PromptItem = {
			id: "catalog:shared", title: "Shared", body: "two", tags: [], source: "团队提示词库", sourceId: "server-public-prompt-catalog",
		};
		useBoardStore.getState().setPrompts([personal]);
		useBoardStore.getState().setPrompts([personal, shared]);
		await useBoardStore.getState().flushPrompts();
		expect(useBoardStore.getState().prompts).toEqual([personal, shared]);
		const saved = fetchCalls
			.filter((call) => call.url.endsWith("/state/prompts") && call.method === "PUT")
			.at(-1)?.body;
		expect(saved).toBe(JSON.stringify([personal]));
	});

	test("retries an asset update when another writer changes the baseline", async () => {
		let releaseFirst!: () => void;
		const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let assetWrites = 0;
		installFetch(async (url, init) => {
			if (url.endsWith("/state/assets") && init.method === "PUT") {
				assetWrites += 1;
				if (assetWrites === 1) await firstWrite;
			}
			return new Response(null, { status: 204 });
		});
		seedProject("asset race", "loaded");
		const first: AssetItem = { id: "a1", kind: "text", title: "first", tags: [], createdAt: "t", updatedAt: "t" };
		const concurrent: AssetItem = { id: "a2", kind: "text", title: "concurrent", tags: [], createdAt: "t", updatedAt: "t" };
		const appended: AssetItem = { id: "a3", kind: "text", title: "appended", tags: [], createdAt: "t", updatedAt: "t" };
		useBoardStore.setState({ assets: [first] });
		const update = useBoardStore.getState().commitAssetUpdate((assets) => [...assets, appended]);
		await Promise.resolve();
		useBoardStore.getState().setAssets([first, concurrent]);
		releaseFirst();
		await update;
		await useBoardStore.getState().flushAssets();
		expect(useBoardStore.getState().assets).toEqual([first, concurrent, appended]);
		expect(assetWrites).toBeGreaterThanOrEqual(2);
	});

	test("autoloads assets for atomic updates and clones inserted node media", async () => {
		const project = seedProject("asset insertion", "loaded");
		const asset: AssetItem = {
			id: "text-asset", kind: "text", title: "Reusable", tags: [], content: "saved text",
			createdAt: "t", updatedAt: "t", thumbnailUrl: "https://thumb.example/image.png",
		};
		installFetch((url, init) => {
			if (url.endsWith("/state/assets") && (init.method ?? "GET") === "GET") return jsonResponse([]);
			return new Response(null, { status: 204 });
		});
		useBoardStore.setState({ assetsState: "idle" });
		await useBoardStore.getState().commitAssetUpdate((assets) => [...assets, asset]);
		expect(useBoardStore.getState().assetsState).toBe("loaded");
		expect(useBoardStore.getState().assets).toEqual([asset]);
		const originalAsset = structuredClone(asset);
		await useBoardStore.getState().insertAsset(asset.id, { x: 42, y: 84 });
		const inserted = activeProject().nodes.find((node) => node.position.x === 42 && node.position.y === 84);
		expect(inserted).toMatchObject({ type: "text", title: "Reusable", metadata: { content: "saved text", status: "success" } });
		expect(asset).toEqual(originalAsset);
		expect(project.nodes).toHaveLength(0);
	});

	test("keeps the local prompt catalog when a public source is stale", async () => {
		const personal: PromptItem = { id: "local", title: "Local", body: "body", tags: [], source: "local" };
		installFetch((url, init) => {
			if (url.endsWith("/config")) return jsonResponse({ config: createDefaultConfig(), secrets: {
				apiKeys: {}, webdavPass: "", objectStorageAccessKeyId: "",
				objectStorageSecretAccessKey: "", objectStorageSessionToken: "",
			} }, 200, { ETag: '"stale-config"' });
			if (url.endsWith("/state/prompts")) return jsonResponse([personal]);
			if (url.endsWith("/prompt-catalog")) return new Response("unavailable", { status: 503 });
			return new Response(null, { status: 204 });
		});
		await useBoardStore.getState().hydrate(`stale-catalog-${crypto.randomUUID()}`);
		await useBoardStore.getState().loadPromptsOnDemand();
		expect(useBoardStore.getState().promptsState).toBe("loaded");
		expect(useBoardStore.getState().prompts).toEqual([personal]);
	});

	test("persists project errors through persistNow instead of hiding them", async () => {
		installFetch((url, init) => {
			if (url.includes("/projects/") && init.method === "PUT") return new Response("offline", { status: 500 });
			return new Response(null, { status: 204 });
		});
		seedProject("project error", "loaded");
		useBoardStore.getState().addNode("text", { x: 0, y: 0 });
		await expect(useBoardStore.getState().persistNow()).rejects.toThrow("Project save failed: HTTP 500");
		expect(activeProject().nodes).toHaveLength(1);
	});
});

describe("board store edge cases and transactional commits", () => {
	test("handles scope-save permissions, chat initialization, and committed project adoption", async () => {
		expect(await saveWorkspaceReplacementConfig(async () => {
			throw new SecretAuthRequiredError();
		})).toBe(false);
		await expect(saveWorkspaceReplacementConfig(async () => { throw new Error("unexpected"); })).rejects.toThrow("unexpected");

		const empty = { ...createProject("empty chat"), chatSessions: [], activeChatId: null };
		const hydrated = ensureChatSession(empty);
		expect(hydrated).not.toBe(empty);
		expect(hydrated.chatSessions).toHaveLength(1);
		expect(hydrated.activeChatId).toBe(hydrated.chatSessions[0]?.id);
		const existing = createProject("existing chat");
		expect(ensureChatSession(existing)).toBe(existing);

		const retained = createProject("retained");
		const committed = createProject("committed");
		useBoardStore.setState({ projectsState: "idle", projects: [retained], activeProjectId: retained.id });
		adoptCommittedProject(committed);
		expect(useBoardStore.getState().projects.map((project) => project.id)).toEqual([committed.id]);
		expect(useBoardStore.getState().exportActiveProject()).not.toBe(committed);
		useBoardStore.setState({ projectsState: "loaded", projects: [retained], activeProjectId: retained.id });
		adoptCommittedProject(committed);
		expect(useBoardStore.getState().projects.map((project) => project.id)).toEqual([committed.id, retained.id]);
		committed.title = "mutated source";
		expect(useBoardStore.getState().projects[0]?.title).toBe("committed");
	});

	test("covers selection no-ops, every alignment mode, vertical distribution, and panorama binding", () => {
		seedProject("selection", "idle");
		useBoardStore.getState().setActiveProject(null);
		useBoardStore.getState().selectAll();
		useBoardStore.getState().captureHistory();
		useBoardStore.getState().undo();
		useBoardStore.getState().redo();
		useBoardStore.getState().setSelected(["missing"]);
		useBoardStore.getState().toggleSelect("missing");
		expect(useBoardStore.getState().selectedIds).toEqual(["missing"]);
		useBoardStore.getState().toggleSelect("missing", true);
		expect(useBoardStore.getState().selectedIds).toEqual([]);

		const project = seedProject("alignment", "idle");
		const a = useBoardStore.getState().addNode("text", { x: 0, y: 0 });
		const b = useBoardStore.getState().addNode("text", { x: 220, y: 120 });
		const c = useBoardStore.getState().addNode("text", { x: 500, y: 300 });
		useBoardStore.getState().setSelected([a, b, c]);
		for (const mode of ["left", "right", "top", "bottom", "hcenter", "vcenter"] as const) {
			useBoardStore.getState().alignSelected(mode);
		}
		useBoardStore.getState().distributeSelected("y");
		const ys = [a, b, c].map((id) => activeProject().nodes.find((node) => node.id === id)!.position.y);
		expect(ys[1]! - ys[0]!).toBe(ys[2]! - ys[1]!);
		useBoardStore.getState().setSelected([a]);
		useBoardStore.getState().alignSelected("left");
		useBoardStore.getState().distributeSelected("x");

		const panorama = useBoardStore.getState().addNode("panorama", { x: 600, y: 0 });
		const director = useBoardStore.getState().addNode("director", { x: 1000, y: 0 });
		useBoardStore.getState().connect(panorama, director);
		expect(activeProject().nodes.find((node) => node.id === director)?.metadata.directorScene?.environment.sourceId)
			.toBe(panorama);
		useBoardStore.getState().setConnectingFrom(director);
		useBoardStore.getState().deleteEdge(activeProject().edges[0]!.id);
		expect(useBoardStore.getState().connectingFrom).toBe(director);
		useBoardStore.getState().bindDirectorPanorama(director, null);
		expect(activeProject().nodes.find((node) => node.id === director)?.metadata.directorScene?.environment.sourceId)
			.toBeNull();
		void project;
	});

	test("adds node assets for each media kind and inserts reusable media", async () => {
		installFetch();
		seedProject("assets", "loaded");
		const text = useBoardStore.getState().addNode("text", { x: 0, y: 0 }, { title: "Copy", metadata: { content: "body" } });
		const image = useBoardStore.getState().addNode("image", { x: 0, y: 400 }, {
			title: "Image", metadata: { content: "blob:image", storageKey: "image:key", mimeType: "image/png" },
		});
		const video = useBoardStore.getState().addNode("video", { x: 0, y: 800 });
		const audio = useBoardStore.getState().addNode("audio", { x: 0, y: 1100 }, {
			title: "Audio", metadata: { content: "blob:audio", storageKey: "media:key", mimeType: "audio/mpeg" },
		});
		await useBoardStore.getState().addAssetFromNode("missing");
		await useBoardStore.getState().addAssetFromNode(text);
		await useBoardStore.getState().addAssetFromNode(image);
		await useBoardStore.getState().addAssetFromNode(video);
		await useBoardStore.getState().addAssetFromNode(audio);
		expect(useBoardStore.getState().assets.map((asset) => asset.kind)).toEqual(["audio", "image", "text"]);

		await useBoardStore.getState().insertAsset(useBoardStore.getState().assets.find((asset) => asset.kind === "image")!.id, { x: 20, y: 20 });
		await useBoardStore.getState().insertAsset(useBoardStore.getState().assets.find((asset) => asset.kind === "audio")!.id, { x: 40, y: 40 });
		const panoramaAsset: AssetItem = {
			id: "panorama-asset", kind: "image", title: "Pano", tags: ["panorama"], notes: "panoramaProjection:equirectangular",
			createdAt: "t", updatedAt: "t",
		};
		useBoardStore.getState().setAssets([...useBoardStore.getState().assets, panoramaAsset]);
		await useBoardStore.getState().insertAsset(panoramaAsset.id, { x: 60, y: 60 });
		expect(activeProject().nodes.some((node) => node.type === "panorama")).toBe(true);
		await useBoardStore.getState().insertAsset("missing", { x: 0, y: 0 });
	});

	test("commits director captures and rolls back failed persistence", async () => {
		installFetch();
		const project = seedProject("capture", "loaded");
		const director = createNode("director", { x: 0, y: 0 }, { id: "director-capture" });
		useBoardStore.setState({ projects: [{ ...project, nodes: [director] }], activeProjectId: project.id });
		const capture = createNode("image", { x: 100, y: 0 }, { id: "capture-one" });
		await useBoardStore.getState().commitDirectorCaptureNodes(project.id, director.id, [capture]);
		expect(activeProject().nodes.map((node) => node.id)).toEqual([director.id, capture.id]);
		expect(useBoardStore.getState().selectedIds).toEqual([capture.id]);

		await expect(useBoardStore.getState().commitDirectorCaptureNodes("missing", director.id, [capture]))
			.rejects.toThrow("不存在");
		await expect(useBoardStore.getState().commitDirectorCaptureNodes(project.id, director.id, []))
			.rejects.toThrow("无效");
		await expect(useBoardStore.getState().commitDirectorCaptureNodes(project.id, director.id, [createNode("text", { x: 0, y: 0 })]))
			.rejects.toThrow("无效");
		await expect(useBoardStore.getState().commitDirectorCaptureNodes(project.id, director.id, [capture, capture]))
			.rejects.toThrow("冲突");

		let writes = 0;
		installFetch((url, init) => {
			if (url.includes("/projects/") && init.method === "PUT") {
				writes += 1;
				if (writes === 1) return new Response("offline", { status: 500 });
			}
			return new Response(null, { status: 204 });
		});
		const rollbackCapture = createNode("image", { x: 200, y: 0 }, { id: "capture-rollback" });
		await expect(useBoardStore.getState().commitDirectorCaptureNodes(project.id, director.id, [rollbackCapture]))
			.rejects.toThrow("Project save failed");
		expect(activeProject().nodes.some((node) => node.id === rollbackCapture.id)).toBe(false);

		writes = 0;
		installFetch((url, init) => {
			if (url.includes("/projects/") && init.method === "PUT") return new Response("offline", { status: 500 });
			return new Response(null, { status: 204 });
		});
		await expect(useBoardStore.getState().commitDirectorCaptureNodes(project.id, director.id, [
			createNode("image", { x: 250, y: 0 }, { id: "capture-double-fail" }),
		])).rejects.toBeInstanceOf(ProjectCommitRollbackError);
	});

	test("commits workflow results and rejects stale or malformed batches", async () => {
		installFetch();
		const project = seedProject("workflow", "loaded");
		const result = createNode("image", { x: 0, y: 0 }, {
			id: "workflow-result", metadata: { workflowRunId: "run-one", storageKey: "image:workflow", content: "blob:workflow" },
		});
		await useBoardStore.getState().commitWorkflowResultNodes(project.id, "run-one", [result]);
		expect(activeProject().nodes.some((node) => node.id === result.id)).toBe(true);
		expect(useBoardStore.getState().selectedIds).toEqual([result.id]);
		await expect(useBoardStore.getState().commitWorkflowResultNodes(project.id, "", [result])).rejects.toThrow("无效");
		await expect(useBoardStore.getState().commitWorkflowResultNodes(project.id, "run-one", [result, result])).rejects.toThrow("重复");
		await expect(useBoardStore.getState().commitWorkflowResultNodes(project.id, "run-one", [createNode("text", { x: 0, y: 0 })]))
			.rejects.toThrow("无效");
		useBoardStore.setState({ activeProjectId: null });
		await expect(useBoardStore.getState().commitWorkflowResultNodes(project.id, "run-one", [createNode("image", { x: 0, y: 0 }, {
			id: "workflow-stale", metadata: { workflowRunId: "run-one", storageKey: "image:stale", content: "blob:stale" },
		})])).rejects.toThrow("变化");
	});

	test("commits a panorama result batch and rejects missing roots", async () => {
		installFetch();
		const project = seedProject("panorama", "loaded");
		const root = createNode("panorama", { x: 0, y: 0 }, {
			id: "panorama-root",
			metadata: { content: "blob:root", storageKey: "image:root", bytes: 10, mimeType: "image/png", naturalWidth: 2048, naturalHeight: 1024 },
		});
		useBoardStore.setState({ projects: [{ ...project, nodes: [root] }], activeProjectId: project.id });
		const results = [1, 2].map((index) => ({
			content: `blob:result-${index}`,
			storageKey: `image:result-${index}`,
			naturalWidth: 2048,
			naturalHeight: 1024,
			bytes: 10,
			mimeType: "image/png",
		}));
		await useBoardStore.getState().commitPanoramaBatch(project.id, root.id, results, {
			prompt: "sunset", model: "pano", quality: "high", referenceStorageKeys: [], generationJobId: "job-1",
		}, { ...activeProject() }, false);
		expect(activeProject().nodes).toHaveLength(2);
		expect(activeProject().nodes[0]?.metadata.batchChildIds).toHaveLength(1);
		await expect(useBoardStore.getState().commitPanoramaBatch(project.id, "missing", results, {
			prompt: "sunset", model: "pano", quality: "high", referenceStorageKeys: [],
		}, { ...activeProject() }, false)).rejects.toThrow("不存在");
	});

	test("commits a validated formal director shot chain", async () => {
		installFetch();
		const project = seedProject("formal shot", "loaded");
		const director = createNode("director", { x: 0, y: 0 }, { id: "director-formal" });
		const scene = director.metadata.directorScene!;
		useBoardStore.setState({ projects: [{ ...project, nodes: [director] }], activeProjectId: project.id });
		const snapshot = {
			version: 1 as const,
			directorNodeId: director.id,
			camera: scene.cameras[0]!,
			background: scene.background,
			environment: scene.environment,
			objects: [],
			omittedObjectCount: 0,
		};
		const capture = createNode("image", { x: 100, y: 0 }, {
			id: "formal-capture",
			metadata: { content: "blob:formal-capture", storageKey: "image:formal-capture", bytes: 10, mimeType: "image/png", directorShot: {
				version: 1, role: "capture", directorNodeId: director.id, captureId: "capture-id",
				capturedAt: "2026-08-01T00:00:00Z", snapshot,
			} },
		});
		const config = createNode("config", { x: 500, y: 0 }, {
			id: "formal-config",
			metadata: { referenceStorageKeys: ["image:formal-capture"], directorShot: {
				version: 1, role: "config", directorNodeId: director.id, captureId: "capture-id",
				capturedAt: "2026-08-01T00:00:00Z", snapshot,
			} },
		});
		const result = createNode("image", { x: 900, y: 0 }, {
			id: "formal-result", metadata: { generationConfigId: config.id, generationRunId: "formal-run" },
		});
		const planned = {
			...activeProject(),
			nodes: [director, capture, config, result],
			edges: [
				{ id: "formal-edge-1", from: director.id, to: capture.id },
				{ id: "formal-edge-2", from: capture.id, to: config.id },
				{ id: "formal-edge-3", from: config.id, to: result.id },
			],
		};
		await useBoardStore.getState().commitDirectorShotRun(project.id, director.id, activeProject().updatedAt, planned);
		expect(activeProject().nodes).toHaveLength(4);
		expect(useBoardStore.getState().selectedIds).toEqual([config.id, result.id]);
		await expect(useBoardStore.getState().commitDirectorShotRun(project.id, director.id, "stale", planned))
			.rejects.toThrow("变化");
		await expect(useBoardStore.getState().commitDirectorShotRun(project.id, director.id, activeProject().updatedAt, {
			...planned, nodes: planned.nodes.slice(0, 1),
		})).rejects.toThrow("计划无效");
	});

	test("cleans staged panorama storage after a failed transactional commit", async () => {
		const project = seedProject("panorama cleanup", "loaded");
		const root = createNode("panorama", { x: 0, y: 0 }, { id: "cleanup-root" });
		useBoardStore.setState({ projects: [{ ...project, nodes: [root] }], activeProjectId: project.id });
		const result = {
			content: "blob:cleanup", storageKey: "image:unretained", naturalWidth: 2048,
			naturalHeight: 1024, bytes: 10, mimeType: "image/png",
		};
		const deleted: string[] = [];
		installFetch((url, init) => {
			if (url.includes("/generation-jobs?") && (init.method ?? "GET") === "GET") {
				return jsonResponse({ items: [], page: 1, pageSize: 100, total: 0 });
			}
			if (init.method === "DELETE") {
				deleted.push(url);
				return new Response(null, { status: 204 });
			}
			return new Response(null, { status: 204 });
		});
		await expect(useBoardStore.getState().commitPanoramaBatch(project.id, "missing", [result], {
			prompt: "p", model: "m", quality: "q", referenceStorageKeys: [],
		}, { ...activeProject() }, true)).rejects.toThrow("不存在");
		expect(deleted.some((url) => decodeURIComponent(url).includes("image:unretained"))).toBe(true);
	});

	test("pastes grouped selections with remapped child membership", () => {
		seedProject("group paste", "idle");
		const first = useBoardStore.getState().addNode("text", { x: 0, y: 0 });
		const second = useBoardStore.getState().addNode("text", { x: 200, y: 0 });
		useBoardStore.getState().setSelected([first, second]);
		useBoardStore.getState().groupSelected();
		const groupId = useBoardStore.getState().selectedIds[0]!;
		useBoardStore.getState().copySelected();
		useBoardStore.getState().pasteClipboard();
		const pastedGroup = activeProject().nodes.find((node) => node.id === useBoardStore.getState().selectedIds[0]);
		expect(pastedGroup?.type).toBe("group");
		expect(pastedGroup?.metadata.childIds?.length).toBe(2);
		expect(pastedGroup?.metadata.childIds).not.toContain(first);
		expect(pastedGroup?.metadata.childIds).not.toContain(second);
		expect(pastedGroup?.id).not.toBe(groupId);
	});

	test("attaches uploaded image, video, and audio nodes through media storage", async () => {
		installFetch();
		seedProject("uploads", "idle");
		const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
		const priorImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
		const fakeWindow = {
			setTimeout: (handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout),
			clearTimeout: (timer: number) => globalThis.clearTimeout(timer),
		};
		class FakeImage {
			naturalWidth = 1024;
			naturalHeight = 512;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_value: string) { queueMicrotask(() => this.onload?.()); }
		}
		const fakeDocument = {
			createElement: (tag: string) => {
				if (tag === "canvas") {
					return {
						width: 0, height: 0,
						getContext: () => ({ imageSmoothingEnabled: false, imageSmoothingQuality: "low", drawImage: () => undefined }),
						toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["preview"], { type: "image/png" })),
					};
				}
				if (tag === "video") {
					const video = {
						muted: false, playsInline: false, preload: "", duration: 1, videoWidth: 640, videoHeight: 360,
						onloadeddata: null as (() => void) | null,
						onerror: null as (() => void) | null,
						onseeked: null as (() => void) | null,
						_src: "",
						set src(value: string) { this._src = value; queueMicrotask(() => this.onloadData()); },
						get src() { return this._src; },
						set currentTime(_value: number) { queueMicrotask(() => this.onseeked?.()); },
						onloadData() { this.onloadeddata?.(); },
						removeAttribute: () => undefined,
						load: () => undefined,
					};
					return video;
				}
				throw new Error(`unsupported element ${tag}`);
			},
		};
		Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
		Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
		Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
		try {
			const imageId = await attachUploadedImage(new Blob(["image"], { type: "image/png" }), { x: 1, y: 2 }, { mode: "image" });
			const videoId = await attachUploadedVideo(new Blob(["video"], { type: "video/mp4" }), { x: 3, y: 4 });
			const audioId = await attachUploadedAudio(new Blob(["audio"], { type: "audio/mpeg" }), { x: 5, y: 6 });
			expect(activeProject().nodes.find((node) => node.id === imageId)?.type).toBe("image");
			expect(activeProject().nodes.find((node) => node.id === videoId)?.type).toBe("video");
			expect(activeProject().nodes.find((node) => node.id === audioId)?.type).toBe("audio");
		} finally {
			if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
			else delete (globalThis as { window?: Window }).window;
			if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument);
			else delete (globalThis as { document?: Document }).document;
			if (priorImage) Object.defineProperty(globalThis, "Image", priorImage);
			else delete (globalThis as { Image?: typeof Image }).Image;
		}
	});
});
