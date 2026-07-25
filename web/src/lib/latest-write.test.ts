import { describe, expect, test } from "bun:test";
import { LatestWrite } from "./latest-write";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LatestWrite", () => {
  test("serializes writes and coalesces pending values to the latest one", async () => {
    const first = deferred();
    const values: string[] = [];
    const writer = new LatestWrite<string>(async (value) => {
      values.push(value);
      if (value === "first") await first.promise;
    });

    writer.enqueue("first");
    writer.enqueue("stale");
    writer.enqueue("latest");
    expect(values).toEqual(["first"]);

    first.resolve();
    await writer.flush();
    expect(values).toEqual(["first", "latest"]);
  });

  test("continues with the latest pending value after a failed write", async () => {
    const first = deferred();
    const values: string[] = [];
    const errors: unknown[] = [];
    const writer = new LatestWrite<string>(async (value) => {
      values.push(value);
      if (value === "first") {
        await first.promise;
        throw new Error("write failed");
      }
    }, (error) => errors.push(error));

    writer.enqueue("first");
    writer.enqueue("latest");
    first.resolve();
    await writer.flush();

    expect(values).toEqual(["first", "latest"]);
    expect(errors).toHaveLength(1);
  });

  test("reports a final write failure and recovers after a later success", async () => {
    let fail = true;
    const writer = new LatestWrite<string>(async () => {
      if (fail) throw new Error("final write failed");
    });

    writer.enqueue("failed");
    await expect(writer.flush()).rejects.toThrow("final write failed");

    fail = false;
    writer.enqueue("recovered");
    await expect(writer.flush()).resolves.toBeUndefined();
  });

  test("serializes exact transactional writes before later coalesced updates", async () => {
    const exact = deferred();
    const values: string[] = [];
    const writer = new LatestWrite<string>(async (value) => {
      values.push(value);
      if (value === "candidate") await exact.promise;
    });

    const candidate = writer.writeExact("candidate");
    writer.enqueue("concurrent-stale");
    writer.enqueue("concurrent-latest");
    await Promise.resolve();
    expect(values).toEqual(["candidate"]);

    exact.resolve();
    await candidate;
    await writer.flush();
    expect(values).toEqual(["candidate", "concurrent-latest"]);
  });

  test("reserves an exact write behind an in-flight ordinary write", async () => {
    const prior = deferred();
    const values: string[] = [];
    const writer = new LatestWrite<string>(async (value) => {
      values.push(value);
      if (value === "prior") await prior.promise;
    });

    writer.enqueue("prior");
    const candidate = writer.writeExact("candidate");
    writer.enqueue("concurrent");
    prior.resolve();
    await candidate;
    await writer.flush();

    expect(values).toEqual(["prior", "candidate", "concurrent"]);
  });
});
