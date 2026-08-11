import { describe, expect, test } from "bun:test";

import {
  collectGenerationStorageKeysFromJobs,
  findInterruptedGenerationJobs,
  findUnreferencedGenerationStorageKeys,
  generationRequestError,
  isServerOwnedGenerationJob,
  paginateGenerationJobs,
  selectGenerationJobsForNodeCleanup,
  selectGenerationJobsForProject,
  uniqueGenerationJobIds,
  validateGenerationJob,
  waitForGenerationJob,
} from "./generation-jobs";
import type { GenerationJob } from "@/types/board";

const job = (id: string, createdAt: string, kind: GenerationJob["kind"] = "image"): GenerationJob => ({
  id,
  kind,
  status: "succeeded",
  prompt: id,
  parameters: {},
  result: {},
  createdAt,
  updatedAt: createdAt,
});

describe("generation job pagination", () => {
  test("accepts durable Film text jobs in the shared task contract", () => {
    const parsed = validateGenerationJob({
      ...job("film-text", "2026-08-11T00:00:00.000Z"),
      kind: "text",
      parameters: { executor: "server", operation: "film_decompose" },
    });
    expect(parsed.kind).toBe("text");
  });

  test("accepts durable Film stage parent jobs in the shared task contract", () => {
    const parsed = validateGenerationJob({
      ...job("film-parent", "2026-08-11T00:00:00.000Z"),
      projectId: "film-project-1",
      kind: "film-stage",
      status: "running",
      prompt: "",
      parameters: { film: { stage: "storyboard" } },
    });
    expect(parsed.kind).toBe("film-stage");
  });

  test("surfaces the server's refusal reason instead of a bare status", () => {
    // A tenant allow-list refusal explains what to change; collapsing it to
    // "HTTP 403" leaves the user with no idea why generation was blocked.
    expect(generationRequestError(403, "model is not in the tenant allow list").message)
      .toContain("model is not in the tenant allow list");
    expect(generationRequestError(403, "cloud channel generation disabled by admin").message)
      .toContain("cloud channel generation disabled by admin");
    const gone = generationRequestError(410, "generation job was deleted") as Error & { status?: number };
    expect(gone.status).toBe(410);
  });

  test("falls back to the status when the body carries no usable reason", () => {
    expect(generationRequestError(500, "").message).toContain("500");
    // An HTML error page or an oversized body is not a reason worth showing.
    expect(generationRequestError(502, "<!doctype html><html>...</html>").message).toContain("502");
    expect(generationRequestError(503, "x".repeat(1000)).message.length).toBeLessThan(400);
  });

  test("filters, sorts newest first, paginates, and leaves input immutable", () => {
    const input = [
      job("old", "2026-07-01T00:00:00Z"),
	  job("video", "2026-07-03T00:00:00Z", "video"),
	  job("audio", "2026-07-03T01:00:00Z", "audio"),
      job("new", "2026-07-02T00:00:00Z"),
    ];
    const page = paginateGenerationJobs(input, { kind: "image", page: 1, pageSize: 1 });
    expect(page.items.map((item) => item.id)).toEqual(["new"]);
    expect(page.total).toBe(2);
	expect(input.map((item) => item.id)).toEqual(["old", "video", "audio", "new"]);
  });

  test("rejects invalid pagination", () => {
    expect(() => paginateGenerationJobs([], { page: 0, pageSize: 20 })).toThrow("page");
    expect(() => paginateGenerationJobs([], { page: 1, pageSize: 101 })).toThrow("pageSize");
  });
});

describe("generation job media lifecycle", () => {
  test("collects references and results without mutating jobs", () => {
    const input = job("with-media", "2026-07-04T00:00:00Z");
    input.parameters = {
      referenceStorageKeys: ["image:reference", "image:shared"],
    };
    input.result = {
      items: [
        { storageKey: "image:result" },
        { storageKey: "image:shared" },
        { url: "https://example.invalid/result.png" },
      ],
    };
    const snapshot = structuredClone(input);

    expect(collectGenerationStorageKeysFromJobs([input])).toEqual(new Set([
      "image:reference",
      "image:shared",
      "image:result",
    ]));
    expect(input).toEqual(snapshot);
  });

  test("only returns deleted-job media that has no remaining owner", () => {
    const removed = job("removed", "2026-07-04T00:00:00Z");
    removed.parameters = { referenceStorageKeys: ["image:orphan-ref", "image:shared"] };
    removed.result = { items: [{ storageKey: "image:orphan-result" }, { storageKey: "image:on-canvas" }] };
    const remaining = job("remaining", "2026-07-05T00:00:00Z");
    remaining.parameters = { referenceStorageKeys: ["image:shared"] };

    expect(findUnreferencedGenerationStorageKeys(
      removed,
      [remaining],
      new Set(["image:on-canvas"]),
    )).toEqual(new Set(["image:orphan-ref", "image:orphan-result"]));
  });
});

describe("generation job recovery", () => {
  test("finds only this tab's persisted running jobs without a live activity", () => {
    const ownedOrphan = { ...job("owned-orphan", "2026-07-05T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-one" } };
    const ownedLive = { ...job("owned-live", "2026-07-05T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-one" } };
    const otherTab = { ...job("other-tab", "2026-07-05T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-two" } };
    const recentOtherTab = { ...job("recent-other-tab", "2026-07-19T00:00:00Z"), status: "running" as const, parameters: { ownerClientId: "tab-two" } };
    const recentLegacy = {
      ...job("recent-legacy", "2026-07-19T00:00:00Z"),
      status: "running" as const,
      parameters: {},
    };

    expect(findInterruptedGenerationJobs(
      [ownedOrphan, ownedLive, otherTab, recentOtherTab, {
        ...job("legacy-orphan", "2026-07-05T00:00:00Z"), status: "running", parameters: {},
      }, recentLegacy, job("complete", "2026-07-05T00:00:00Z")],
      "tab-one",
      new Set(["owned-live"]),
      Date.parse("2026-07-19T00:10:00Z"),
    ).map((item) => item.id)).toEqual(["owned-orphan", "other-tab", "legacy-orphan"]);
  });

	test("never classifies server-owned jobs as browser-interrupted", () => {
		const serverJob = {
			...job("server-running", "2026-07-05T00:00:00Z"),
			status: "running" as const,
			parameters: { executor: "server", ownerClientId: "tab-one" },
		};
		expect(findInterruptedGenerationJobs(
			[serverJob],
			"tab-one",
			new Set(),
			Date.parse("2026-07-19T00:10:00Z"),
		)).toEqual([]);
	});

	test("recognizes Film stage and export workers as server-owned", () => {
		expect(isServerOwnedGenerationJob({
			...job("film-stage", "2026-07-05T00:00:00Z", "film-stage"),
			parameters: { executor: "film-stage" },
		})).toBe(true);
		expect(isServerOwnedGenerationJob({
			...job("film-export", "2026-07-05T00:00:00Z", "export"),
			parameters: { executor: "film-export" },
		})).toBe(true);
	});


	test("stops polling when a job is soft-deleted", async () => {
		const states: GenerationJob[] = [
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "running", parameters: { executor: "server" } },
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "deleted", parameters: { executor: "server" } },
		];
		const completed = await waitForGenerationJob("server-job", {
			getJob: async () => states.shift(),
			wait: async () => undefined,
		});
		expect(completed.status).toBe("deleted");
	});

	test("polls one persisted server job until it reaches a terminal state", async () => {
		const states: GenerationJob[] = [
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "queued", parameters: { executor: "server" } },
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "running", parameters: { executor: "server" } },
			{ ...job("server-job", "2026-07-05T00:00:00Z"), status: "succeeded", parameters: { executor: "server" } },
		];
		const requested: string[] = [];
		const observed: string[] = [];
		const completed = await waitForGenerationJob("server-job", {
			getJob: async (id) => {
				requested.push(id);
				return states.shift();
			},
			wait: async () => undefined,
			onUpdate: (value) => observed.push(value.status),
		});
		expect(completed.status).toBe("succeeded");
		expect(requested).toEqual(["server-job", "server-job", "server-job"]);
		expect(observed).toEqual(["queued", "running", "succeeded"]);
	});
});

describe("generation job cascade cleanup", () => {
  test("selects only the requested project history", () => {
    const jobs = [
      { ...job("job-a", "2026-07-01T00:00:00.000Z"), projectId: "board-a" },
      { ...job("job-b", "2026-07-01T00:00:00.000Z", "video"), projectId: "board-b" },
    ];
    expect(selectGenerationJobsForProject(jobs, "board-a").map((item) => item.id)).toEqual(["job-a"]);
  });

  test("selects node-linked jobs by nodeId or generationJobId", () => {
    const jobs = [
      {
        ...job("job-node", "2026-07-01T00:00:00.000Z"),
        projectId: "board-a",
        parameters: { nodeId: "node-1" },
      },
      {
        ...job("job-linked", "2026-07-01T00:00:00.000Z"),
        projectId: "board-a",
      },
      {
        ...job("job-other", "2026-07-01T00:00:00.000Z"),
        projectId: "board-a",
        parameters: { nodeId: "node-2" },
      },
      {
        ...job("job-foreign", "2026-07-01T00:00:00.000Z"),
        projectId: "board-b",
        parameters: { nodeId: "node-1" },
      },
    ];
    expect(selectGenerationJobsForNodeCleanup(
      jobs,
      "board-a",
      new Set(["node-1"]),
      new Set(["job-linked"]),
    ).map((item) => item.id).sort()).toEqual(["job-linked", "job-node"]);
  });
});

describe("generation job bulk delete helpers", () => {
  test("deduplicates and validates job ids", () => {
    expect(uniqueGenerationJobIds(["job-a", "job-a", "../bad", "job-b", ""])).toEqual(["job-a", "job-b"]);
  });
});

describe("generation job soft delete status", () => {
  test("accepts soft-deleted generation status", () => {
    const deleted = validateGenerationJob({
      ...job("job-soft", "2026-07-01T00:00:00.000Z"),
      status: "deleted",
      error: "已删除",
      result: { items: [{ storageKey: "image:soft" }] },
    });
    expect(deleted.status).toBe("deleted");
  });
});
