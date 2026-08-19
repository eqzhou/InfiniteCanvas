import { describe, expect, test } from "bun:test";
import type { GenerationJob } from "@/types/board";
import {
  loadPanoramaServerResults,
  resumePanoramaServerGeneration,
  runPanoramaServerGeneration,
} from "./panorama-server-generation";

function png(width: number, height: number): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return new Blob([bytes], { type: "image/png" });
}

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job-panorama",
    projectId: "project-one",
    kind: "image",
    status: "succeeded",
    prompt: "a seamless mountain world",
    providerId: "channel-one",
    model: "gpt-image-2",
    parameters: { executor: "server", category: "panorama" },
    result: {
      items: [{
        storageKey: "image:panorama-one",
        mimeType: "image/png",
        width: 2048,
        height: 1024,
        bytes: 24,
      }],
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("panorama server generation", () => {
  test("submits the existing server image task contract and loads its durable result", async () => {
    const submitted: unknown[] = [];
    const created = job({ status: "queued", result: {} });
    const completed = job();

    const result = await runPanoramaServerGeneration({
      projectId: "project-one",
      prompt: "a seamless mountain world",
      providerId: "channel-one",
      model: "gpt-image-2",
      size: "2048x1024",
      quality: "high",
      count: 1,
      referenceStorageKeys: ["image:source-one"],
    }, {
      createJob: async (input) => {
        submitted.push(input);
        return created;
      },
      waitForJob: async () => completed,
      readBlob: async (storageKey) => storageKey === "image:panorama-one" ? png(2048, 1024) : undefined,
      createObjectURL: () => "blob:panorama-one",
    });

    expect(submitted).toEqual([{
      projectId: "project-one",
      prompt: "a seamless mountain world",
      providerId: "channel-one",
      model: "gpt-image-2",
      parameters: {
        size: "2048x1024",
        quality: "high",
        count: 1,
        requestedCount: 1,
        category: "panorama",
        referenceStorageKeys: ["image:source-one"],
      },
    }]);
    expect(result).toEqual({
      jobId: "job-panorama",
      jobIds: ["job-panorama"],
      media: [{
        content: "blob:panorama-one",
        storageKey: "image:panorama-one",
        naturalWidth: 2048,
        naturalHeight: 1024,
        bytes: 24,
        mimeType: "image/png",
      }],
    });
  });

  test("rejects a successful server result that is not a strict 2:1 panorama", async () => {
    await expect(loadPanoramaServerResults(job({
      result: {
        items: [{
          storageKey: "image:not-panorama",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          bytes: 24,
        }],
      },
    }), 1, {
      readBlob: async () => png(1024, 1024),
      createObjectURL: () => "blob:not-panorama",
    })).rejects.toThrow("全景图片必须是 2:1 等距柱状投影");
  });

  test("rejects an unrelated generation job before reading any media", async () => {
    let reads = 0;
    await expect(loadPanoramaServerResults(job({
      projectId: "another-project",
    }), 1, {
      readBlob: async () => {
        reads += 1;
        return png(2048, 1024);
      },
      createObjectURL: () => "blob:must-not-exist",
    }, {
      jobId: "job-panorama",
      projectId: "project-one",
    })).rejects.toThrow("全景生成任务与当前项目不匹配");

    expect(reads).toBe(0);
  });

  test("rejects an oversized server batch before reading any media", async () => {
    let reads = 0;
    const items = Array.from({ length: 8 }, (_, index) => ({
      storageKey: `image:panorama-${index}`,
      mimeType: "image/png",
      width: 2048,
      height: 1024,
      bytes: 9 * 1024 * 1024,
    }));
    await expect(loadPanoramaServerResults(job({ result: { items } }), 8, {
      readBlob: async () => {
        reads += 1;
        return png(2048, 1024);
      },
      createObjectURL: () => "blob:must-not-exist",
    }, {
      jobId: "job-panorama",
      projectId: "project-one",
    })).rejects.toThrow("全景生成批次超出 64 MB 或 6400 万像素限制");

    expect(reads).toBe(0);
  });

  test("preserves the server task error instead of collapsing it into a channel hint", async () => {
    await expect(loadPanoramaServerResults(job({
      status: "failed",
      error: "模型服务拒绝了图片请求（HTTP 400），请检查模型、尺寸和参数",
      result: {},
    }), 1, {
      readBlob: async () => undefined,
      createObjectURL: () => "",
    })).rejects.toThrow("模型服务拒绝了图片请求（HTTP 400），请检查模型、尺寸和参数");
  });

  test("resumes a durable panorama task after the canvas reloads", async () => {
    const waited: string[] = [];
    const result = await resumePanoramaServerGeneration("job-panorama", "project-one", 1, undefined, {
      waitForJob: async (id) => {
        waited.push(id);
        return job();
      },
      readBlob: async () => png(2048, 1024),
      createObjectURL: () => "blob:resumed-panorama",
    });

    expect(waited).toEqual(["job-panorama"]);
    expect(result[0]?.storageKey).toBe("image:panorama-one");
  });

  test("keeps polling the same durable job after a transient read failure", async () => {
    let polls = 0;
    const result = await runPanoramaServerGeneration({
      projectId: "project-one",
      prompt: "a seamless mountain world",
      providerId: "channel-one",
      model: "gpt-image-2",
      size: "2048x1024",
      quality: "high",
      count: 1,
      referenceStorageKeys: [],
    }, {
      createJob: async () => job({ status: "queued", result: {} }),
      waitForJob: async () => {
        polls += 1;
        if (polls === 1) throw new TypeError("Failed to fetch");
        return job();
      },
      retryAfterFailure: async () => undefined,
      readBlob: async () => png(2048, 1024),
      createObjectURL: () => "blob:retried-panorama",
    });

    expect(polls).toBe(2);
    expect(result.jobId).toBe("job-panorama");
  });

  test("does not treat an expired session as proof that the durable job stopped", async () => {
    let polls = 0;
    const retryAttempts: number[] = [];
    const unauthorized = Object.assign(new Error("session expired"), { status: 401 });
    const result = await resumePanoramaServerGeneration("job-panorama", "project-one", 1, undefined, {
      waitForJob: async () => {
        polls += 1;
        if (polls === 1) throw unauthorized;
        return job();
      },
      retryAfterFailure: async (attempt) => {
        retryAttempts.push(attempt);
      },
      readBlob: async () => png(2048, 1024),
      createObjectURL: () => "blob:reauthenticated-panorama",
    });

    expect(retryAttempts).toEqual([1]);
    expect(result[0]?.storageKey).toBe("image:panorama-one");
  });

  test("resumes a count=2 split from the stored job id list", async () => {
    const waited: string[] = [];
    const media = await resumePanoramaServerGeneration("job-a", "project-one", 2, undefined, {
      waitForJob: async (id) => {
        waited.push(id);
        return job({
          id,
          result: {
            items: [{
              storageKey: `image:${id}`,
              mimeType: "image/png",
              width: 2048,
              height: 1024,
              bytes: 24,
            }],
          },
        });
      },
      readBlob: async () => png(2048, 1024),
      createObjectURL: () => "blob:split",
    }, ["job-a", "job-b"]);

    expect(waited).toEqual(["job-a", "job-b"]);
    expect(media.map((item) => item.storageKey)).toEqual(["image:job-a", "image:job-b"]);
  });

  test("resumes a legacy Count=N panorama from a single job when expectedCount is the image count", async () => {
    const media = await resumePanoramaServerGeneration("job-panorama", "project-one", 2, undefined, {
      waitForJob: async () => job({
        result: {
          items: [
            { storageKey: "image:panorama-one", mimeType: "image/png", width: 2048, height: 1024, bytes: 24 },
            { storageKey: "image:panorama-two", mimeType: "image/png", width: 2048, height: 1024, bytes: 24 },
          ],
        },
      }),
      readBlob: async () => png(2048, 1024),
      createObjectURL: () => "blob:legacy",
    });

    expect(media.map((item) => item.storageKey)).toEqual(["image:panorama-one", "image:panorama-two"]);
  });

  test("cancels remaining panorama slots when one n=1 job fails", async () => {
    const cancelled: string[] = [];
    let finishB: ((value: GenerationJob) => void) | undefined;
    const pendingB = new Promise<GenerationJob>((resolve) => { finishB = resolve; });
    await expect(resumePanoramaServerGeneration("job-a", "project-one", 2, undefined, {
      waitForJob: async (id) => {
        if (id === "job-a") return job({ id, status: "failed", error: "provider down", result: {} });
        return pendingB;
      },
      cancelJob: async (id) => {
        cancelled.push(id);
        return job({ id, status: "cancelled", result: {} });
      },
      readBlob: async () => png(2048, 1024),
      createObjectURL: () => "blob:cancelled",
    }, ["job-a", "job-b"])).rejects.toThrow("provider down");

    expect([...cancelled].sort()).toEqual(["job-a", "job-b"]);
    finishB?.(job({ id: "job-b", status: "cancelled", result: {} }));
  });

  test("fans a count=2 panorama request into two n=1 server jobs", async () => {
    const submitted: Array<{ id?: string; parameters: { count?: number; requestedCount?: number; batchIndex?: number } }> = [];
    let created = 0;
    const result = await runPanoramaServerGeneration({
      projectId: "project-one",
      prompt: "two worlds",
      providerId: "channel-one",
      model: "gpt-image-2",
      size: "2048x1024",
      quality: "high",
      count: 2,
      referenceStorageKeys: [],
    }, {
      createJob: async (input) => {
        created += 1;
        submitted.push({ parameters: input.parameters });
        return job({
          id: `job-panorama-${created}`,
          status: "queued",
          result: {},
        });
      },
      waitForJob: async (id) => job({
        id,
        result: {
          items: [{
            storageKey: `image:${id}`,
            mimeType: "image/png",
            width: 2048,
            height: 1024,
            bytes: 24,
          }],
        },
      }),
      readBlob: async () => png(2048, 1024),
      createObjectURL: (blob) => `blob:${blob.size}`,
    });

    expect(submitted.map((item) => item.parameters.count)).toEqual([1, 1]);
    expect(submitted.map((item) => item.parameters.requestedCount)).toEqual([2, 2]);
    expect(submitted.map((item) => item.parameters.batchIndex)).toEqual([1, 2]);
    expect(result.jobIds).toEqual(["job-panorama-1", "job-panorama-2"]);
    expect(result.media.map((item) => item.storageKey)).toEqual(["image:job-panorama-1", "image:job-panorama-2"]);
  });
});
