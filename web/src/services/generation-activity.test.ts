import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearGenerationActivities,
  completeGenerationActivity,
  getGenerationActivities,
  runTrackedGeneration,
} from "./generation-activity";

describe("unified generation activity", () => {
  beforeEach(() => clearGenerationActivities());

  test("publishes immutable running and succeeded snapshots", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const result = runTrackedGeneration({ kind: "image", prompt: "red product", model: "image-one", providerId: "channel-one" }, () => pending);
    const running = getGenerationActivities();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ kind: "image", status: "running", prompt: "red product", surface: "canvas" });
    release("done");
    expect(await result).toBe("done");
    const finished = getGenerationActivities();
    expect(finished[0]?.status).toBe("succeeded");
    expect(finished).not.toBe(running);
    expect(running[0]?.status).toBe("running");
  });

  test("distinguishes cancellation from failure", async () => {
    await expect(runTrackedGeneration({ kind: "video", prompt: "clip" }, async () => {
      throw new DOMException("cancelled", "AbortError");
    })).rejects.toThrow();
    await expect(runTrackedGeneration({ kind: "text", prompt: "copy" }, async () => {
      throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    expect(getGenerationActivities().map((item) => item.status)).toEqual(["failed", "cancelled"]);
    expect(getGenerationActivities()[0]?.error).toBe("provider failed");
  });

  test("keeps externally completed workbench activity running through media persistence", async () => {
    await expect(runTrackedGeneration({
      id: "job-one",
      kind: "image",
      prompt: "persist result",
      surface: "image-workbench",
      deferSuccess: true,
    }, async () => "provider-result")).resolves.toBe("provider-result");

    expect(getGenerationActivities()[0]).toMatchObject({ id: "job-one", status: "running" });
    completeGenerationActivity("job-one", "failed", "media upload failed");
    expect(getGenerationActivities()[0]).toMatchObject({
      id: "job-one",
      status: "failed",
      error: "media upload failed",
    });
  });
});
