import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AppConfig, GenerationJob } from "@/types/board";
import type { WorkflowTemplate } from "@/types/workflow";
import { createDefaultConfig } from "@/lib/defaults";
import { buildWorkflowGenerationJob } from "@/lib/workflow-job";

// The browser workflow executor reaches for IndexedDB, the provider HTTP stack and
// the job history table. Stubbing those modules keeps the test on the scheduling
// logic, which is the part with no coverage today.
//
// `mock.module` is process-wide and never reverts, so each stub spreads the real
// module and overrides only the calls this test makes. Without the spread, a test
// file running after this one would import a module stripped of every other
// export -- a break that would silently depend on file ordering.
const [realAiClient, realStorage, realGenerationJobs] = await Promise.all([
  import("@/services/ai-client"),
  import("@/services/storage"),
  import("@/services/generation-jobs"),
]);

const generatedPrompts: string[] = [];
let imageFailure: ((prompt: string) => Error | undefined) | undefined;
const testCredential = (label: string) => `${label}-test-credential`;

mock.module("@/services/ai-client", () => ({
  ...realAiClient,
  generateImages: async (options: { prompt: string }) => {
    generatedPrompts.push(options.prompt);
    const failure = imageFailure?.(options.prompt);
    if (failure) throw failure;
    return ["data:image/png;base64,AAAA"];
  },
}));

mock.module("@/services/storage", () => ({
  ...realStorage,
  uploadMedia: async () => ({ storageKey: `image:${generatedPrompts.length}`, url: "blob:stub", blob: new Blob() }),
  deleteStorageKey: async () => undefined,
  getBlob: async () => new Blob(["x"], { type: "image/png" }),
  blobToDataUrl: async () => "data:image/png;base64,AAAA",
}));

// `generation-activity` is deliberately NOT stubbed: `mock.module` replaces a
// module for the whole test process, and a partial stub would strip
// `runTrackedGeneration` from every later file. The real
// `completeGenerationActivity` no-ops for ids it never published, which is the
// case here.

const jobs = new Map<string, GenerationJob>();

mock.module("@/services/generation-jobs", () => ({
  ...realGenerationJobs,
  usesServerGenerationJobs: () => false,
  createGenerationJob: async (job: GenerationJob) => {
    jobs.set(job.id, job);
    return job;
  },
  getGenerationJob: async (id: string) => jobs.get(id),
  updateGenerationJob: async (id: string, patch: Partial<GenerationJob>) => {
    const next = { ...(jobs.get(id) ?? ({ id } as GenerationJob)), ...patch } as GenerationJob;
    jobs.set(id, next);
    return next;
  },
  listGenerationJobs: async () => ({ items: [], total: 0 }),
  cancelServerGenerationJob: async (id: string) => jobs.get(id)!,
  waitForGenerationJob: async (id: string) => jobs.get(id)!,
}));

const { executeBrowserWorkflowRun } = await import("./workflow-runs");

const template: WorkflowTemplate = {
  schemaVersion: 1,
  id: "workflow_fanout",
  revision: 1,
  scope: "personal",
  title: "Fan out",
  description: "",
  category: "test",
  variables: [],
  steps: [
    { id: "left", title: "Left", promptTemplate: "left", providerId: "", parameters: { size: "1024x1024", count: 1 }, references: [] },
    { id: "right", title: "Right", promptTemplate: "right", providerId: "", parameters: { size: "1024x1024", count: 1 }, references: [] },
  ],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function configuredChannels(): AppConfig {
  const config = createDefaultConfig();
  const channel = {
    ...config.channels[0]!,
    apiKey: testCredential("channel"),
    providers: {
      ...config.channels[0]!.providers,
      image: { baseUrl: "https://example.invalid/v1", apiKey: testCredential("image"), model: "gpt-image-1", protocol: "openai" as const },
    },
  };
  return { ...config, channels: [channel], activeChannelId: channel.id };
}

function workflowJob(): GenerationJob {
  const job = buildWorkflowGenerationJob({
    id: "workflow_run_fanout",
    template,
    values: {},
    executor: "browser",
    timestamp: "2026-08-01T00:00:00.000Z",
  });
  jobs.set(job.id, job);
  return job;
}

beforeEach(() => {
  generatedPrompts.length = 0;
  imageFailure = undefined;
  jobs.clear();
});

describe("browser workflow batches", () => {
  test("stops calling the paid provider once a step in the batch fails", async () => {
    // Both steps are ready in the same batch. The server worker aborts the run on
    // the first non-succeeded step, so the browser executor must not keep spending
    // generations on a run that already finalizes as failed.
    imageFailure = (prompt) => (prompt === "left" ? new Error("Image provider rejected the request") : undefined);
    const finished = await executeBrowserWorkflowRun(workflowJob(), configuredChannels());

    expect(finished.status).toBe("failed");
    expect(generatedPrompts).toEqual(["left"]);
  });

  test("runs every ready step when none of them fail", async () => {
    const finished = await executeBrowserWorkflowRun(workflowJob(), configuredChannels());

    expect(finished.status).toBe("succeeded");
    expect(generatedPrompts.toSorted()).toEqual(["left", "right"]);
  });
});
