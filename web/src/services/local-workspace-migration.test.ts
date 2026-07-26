import { describe, expect, test } from "bun:test";
import {
  advanceMigrationJournal,
  createLocalWorkspaceInventory,
  createMigrationPreflight,
  createMigrationJournal,
  createWorkspaceManifest,
  canonicalizeMigrationJson,
  executeWorkspaceMigration,
  fingerprintBytes,
  fingerprintValue,
  planMigrationBatches,
  planWorkspaceMigration,
} from "./local-workspace-migration";
import { MigrationPreconditionError } from "./server-storage";

const entry = (
  kind: "project" | "state" | "secret" | "blob",
  id: string,
  fingerprint: string,
  bytes = 1,
) => ({ kind, id, fingerprint, bytes });

describe("local workspace migration manifest", () => {
  test("builds a deterministic, immutable inventory and rejects duplicate resource identities", () => {
    const manifest = createWorkspaceManifest([
      entry("blob", "media:z", "z", 20),
      entry("project", "project:a", "a", 10),
      entry("state", "assets", "assets", 5),
    ]);
    const inventory = createLocalWorkspaceInventory(manifest);

    expect(manifest.entries.map(({ id }) => id)).toEqual(["media:z", "project:a", "assets"]);
    expect(inventory).toEqual({
      version: 1,
      resourceCount: 3,
      totalBytes: 35,
      counts: { project: 1, state: 1, secret: 0, blob: 1 },
      manifest,
    });
    expect(() => createWorkspaceManifest([
      entry("state", "assets", "one"),
      entry("state", "assets", "two"),
    ])).toThrow("duplicate");
  });

  test("fingerprints object key order deterministically and distinguishes binary content", () => {
    expect(fingerprintValue({ b: 2, a: [1, { y: false, x: "yes" }] }))
      .toBe(fingerprintValue({ a: [1, { x: "yes", y: false }], b: 2 }));
    expect(fingerprintBytes(new Uint8Array([1, 2, 3])))
      .not.toBe(fingerprintBytes(new Uint8Array([1, 2, 4])));
  });

  test("canonicalizes values exactly as the JSON transport does", () => {
    expect(canonicalizeMigrationJson({ keep: 1, omitted: undefined, values: [undefined, 2] }))
      .toEqual({ keep: 1, values: [null, 2] });
  });
});

describe("local workspace conflict and batch planning", () => {
  test("builds a read-only preflight summary with counts, pending bytes, and conflicts", () => {
    const local = createWorkspaceManifest([
      entry("project", "project:a", "same", 10),
      entry("blob", "image:new", "new", 30),
      entry("state", "assets", "local", 20),
    ]);
    const remote = createWorkspaceManifest([
      entry("project", "project:a", "same", 99),
      entry("state", "assets", "remote", 22),
    ]);

    const preflight = createMigrationPreflight(local, remote);
    expect(preflight.inventory.resourceCount).toBe(3);
    expect(preflight.inventory.totalBytes).toBe(60);
    expect(preflight.operations.map(({ entry: item }) => item.id)).toEqual(["image:new"]);
    expect(preflight.alreadyPresent.map(({ id }) => id)).toEqual(["project:a"]);
    expect(preflight.conflicts.map(({ local: item }) => item.id)).toEqual(["assets"]);
    expect(preflight.pendingBytes).toBe(30);
  });

  test("resumes a partial migration, skips exact resources, and blocks divergent identities", () => {
    const local = createWorkspaceManifest([
      entry("project", "project:a", "same", 10),
      entry("state", "assets", "local-assets", 20),
      entry("blob", "image:new", "new", 30),
    ]);
    const remote = createWorkspaceManifest([
      entry("project", "project:a", "same", 10),
      entry("state", "assets", "remote-assets", 22),
    ]);

    const plan = planWorkspaceMigration(local, remote);
    expect(plan.alreadyPresent.map(({ id }) => id)).toEqual(["project:a"]);
    expect(plan.operations.map(({ entry: item }) => item.id)).toEqual(["image:new"]);
    expect(plan.conflicts.map(({ local: item }) => item.id)).toEqual(["assets"]);
    expect(plan.conflicts[0]?.remote.fingerprint).toBe("remote-assets");
  });

  test("creates stable bounded batches and omits completed operation ids", () => {
    const plan = planWorkspaceMigration(createWorkspaceManifest([
      entry("blob", "a", "a", 6),
      entry("blob", "b", "b", 6),
      entry("blob", "c", "c", 2),
    ]), createWorkspaceManifest([]));
    const completed = new Set([plan.operations[0]!.id]);

    const batches = planMigrationBatches(plan.operations, completed, { maxItems: 2, maxBytes: 8 });
    expect(batches.map((batch) => batch.operations.map(({ entry: item }) => item.id)))
      .toEqual([["b", "c"]]);
    expect(planMigrationBatches(plan.operations, new Set(plan.operations.map(({ id }) => id)), {
      maxItems: 2,
      maxBytes: 8,
    })).toEqual([]);
  });
});

describe("local workspace migration journal", () => {
  test("only allows forward state transitions and creates new journal objects", () => {
    const created = createMigrationJournal("manifest-one");
    const planned = advanceMigrationJournal(created, "planned");
    const transferring = advanceMigrationJournal(planned, "transferring", { completedOperationIds: ["one"] });

    expect(created.status).toBe("inventory");
    expect(planned).not.toBe(created);
    expect(transferring.completedOperationIds).toEqual(["one"]);
    expect(() => advanceMigrationJournal(transferring, "inventory")).toThrow("transition");
    expect(() => advanceMigrationJournal(created, "complete")).toThrow("transition");
  });
});

describe("safe local workspace migration execution", () => {
  test("never writes or clears when the remote manifest conflicts", async () => {
    const local = createWorkspaceManifest([entry("state", "assets", "local")]);
    let writes = 0;
    let clears = 0;
    const result = await executeWorkspaceMigration({
      localManifest: local,
      loadRemoteManifest: async () => createWorkspaceManifest([entry("state", "assets", "remote")]),
      applyBatch: async () => { writes += 1; },
      clearLocal: async () => { clears += 1; },
    });

    expect(result.status).toBe("conflict");
    expect(result.plan.conflicts).toHaveLength(1);
    expect(writes).toBe(0);
    expect(clears).toBe(0);
  });

  test("resumes completed batches and clears only after a reloaded server manifest verifies every item", async () => {
    const local = createWorkspaceManifest([
      entry("project", "project:a", "a", 4),
      entry("blob", "image:a", "image", 8),
    ]);
    const firstPlan = planWorkspaceMigration(local, createWorkspaceManifest([]));
    const prior = advanceMigrationJournal(
      advanceMigrationJournal(createMigrationJournal(local.fingerprint), "planned"),
      "transferring",
      { completedOperationIds: [firstPlan.operations.find(({ entry: item }) => item.id === "project:a")!.id] },
    );
    const applied: string[] = [];
    let remote = createWorkspaceManifest([local.entries.find(({ id }) => id === "project:a")!]);
    let clears = 0;

    const result = await executeWorkspaceMigration({
      localManifest: local,
      journal: prior,
      loadRemoteManifest: async () => remote,
      applyBatch: async (batch) => {
        applied.push(...batch.operations.map(({ entry: item }) => item.id));
        remote = local;
      },
      clearLocal: async () => { clears += 1; },
      limits: { maxItems: 1, maxBytes: 16 },
    });

    expect(applied).toEqual(["image:a"]);
    expect(clears).toBe(1);
    expect(result.status).toBe("complete");
    expect(result.journal.status).toBe("complete");
  });

  test("records completed batches after a partial write failure and retries only the missing resource", async () => {
    const local = createWorkspaceManifest([
      entry("blob", "image:a", "a", 4),
      entry("blob", "image:b", "b", 4),
    ]);
    let remote = createWorkspaceManifest([]);
    let firstAttempts = 0;
    let clears = 0;
    const first = await executeWorkspaceMigration({
      localManifest: local,
      loadRemoteManifest: async () => remote,
      applyBatch: async (batch) => {
        firstAttempts += 1;
        if (firstAttempts === 1) remote = createWorkspaceManifest([batch.operations[0]!.entry]);
        else throw new Error("temporary upload failure");
      },
      clearLocal: async () => { clears += 1; },
      limits: { maxItems: 1, maxBytes: 8 },
    });
    expect(first.status).toBe("failed");
    expect(first.journal.completedOperationIds).toHaveLength(1);
    expect(clears).toBe(0);

    const retried: string[] = [];
    const second = await executeWorkspaceMigration({
      localManifest: local,
      journal: first.journal,
      loadRemoteManifest: async () => remote,
      applyBatch: async (batch) => {
        retried.push(...batch.operations.map(({ entry: item }) => item.id));
        remote = local;
      },
      clearLocal: async () => { clears += 1; },
      limits: { maxItems: 1, maxBytes: 8 },
    });
    expect(retried).toEqual(["image:b"]);
    expect(second.status).toBe("complete");
    expect(clears).toBe(1);
  });

  test("retains all local data when a concurrent remote create invalidates preflight", async () => {
    const local = createWorkspaceManifest([entry("state", "assets", "local-assets")]);
    let clears = 0;
    const result = await executeWorkspaceMigration({
      localManifest: local,
      loadRemoteManifest: async () => createWorkspaceManifest([]),
      applyBatch: async () => { throw new MigrationPreconditionError(); },
      clearLocal: async () => { clears += 1; },
    });

    expect(result.status).toBe("failed");
    expect(result.journal.status).toBe("failed");
    expect(result.journal.completedOperationIds).toEqual([]);
    expect(clears).toBe(0);
  });

  test("re-uploads an operation recorded complete when the server no longer has it", async () => {
    const local = createWorkspaceManifest([entry("blob", "image:a", "a", 4)]);
    const operation = planWorkspaceMigration(local, createWorkspaceManifest([])).operations[0]!;
    const stale = advanceMigrationJournal(
      advanceMigrationJournal(createMigrationJournal(local.fingerprint), "planned"),
      "transferring",
      { completedOperationIds: [operation.id] },
    );
    let remote = createWorkspaceManifest([]);
    const uploaded: string[] = [];
    const result = await executeWorkspaceMigration({
      localManifest: local,
      journal: stale,
      loadRemoteManifest: async () => remote,
      applyBatch: async (batch) => {
        uploaded.push(...batch.operations.map(({ entry: item }) => item.id));
        remote = local;
      },
      clearLocal: async () => undefined,
    });
    expect(uploaded).toEqual(["image:a"]);
    expect(result.status).toBe("complete");
  });

  test("retains local data when the post-write server manifest is incomplete", async () => {
    const local = createWorkspaceManifest([entry("blob", "image:a", "image", 8)]);
    let clears = 0;
    const result = await executeWorkspaceMigration({
      localManifest: local,
      loadRemoteManifest: async () => createWorkspaceManifest([]),
      applyBatch: async () => undefined,
      clearLocal: async () => { clears += 1; },
    });

    expect(result.status).toBe("verification-failed");
    expect(result.journal.status).toBe("failed");
    expect(clears).toBe(0);
  });

  test("does not trust a completed journal while local resources still exist", async () => {
    const local = createWorkspaceManifest([entry("state", "assets", "assets")]);
    const completeJournal = {
      ...createMigrationJournal(local.fingerprint),
      status: "complete" as const,
      completedOperationIds: [],
    };
    let remoteReads = 0;
    let clears = 0;
    const result = await executeWorkspaceMigration({
      localManifest: local,
      journal: completeJournal,
      loadRemoteManifest: async () => {
        remoteReads += 1;
        return local;
      },
      applyBatch: async () => undefined,
      clearLocal: async () => { clears += 1; },
    });

    expect(result.status).toBe("complete");
    expect(remoteReads).toBe(2);
    expect(clears).toBe(1);
  });

  test("cancels before the next batch without clearing and resumes missing work", async () => {
    const local = createWorkspaceManifest([
      entry("blob", "image:a", "a", 4),
      entry("blob", "image:b", "b", 4),
    ]);
    const controller = new AbortController();
    let remote = createWorkspaceManifest([]);
    let clears = 0;
    const first = await executeWorkspaceMigration({
      localManifest: local,
      signal: controller.signal,
      loadRemoteManifest: async () => remote,
      applyBatch: async (batch) => {
        remote = createWorkspaceManifest([batch.operations[0]!.entry]);
        controller.abort();
      },
      clearLocal: async () => { clears += 1; },
      limits: { maxItems: 1, maxBytes: 8 },
    });
    expect(first.status).toBe("cancelled");
    expect(first.journal.status).toBe("cancelled");
    expect(first.journal.completedOperationIds).toHaveLength(1);
    expect(clears).toBe(0);

    const uploaded: string[] = [];
    const second = await executeWorkspaceMigration({
      localManifest: local,
      journal: first.journal,
      loadRemoteManifest: async () => remote,
      applyBatch: async (batch) => {
        uploaded.push(...batch.operations.map(({ entry: item }) => item.id));
        remote = local;
      },
      clearLocal: async () => { clears += 1; },
      limits: { maxItems: 1, maxBytes: 8 },
    });
    expect(uploaded).toEqual(["image:b"]);
    expect(second.status).toBe("complete");
    expect(clears).toBe(1);
  });

  test("counts generation history and referenced media as independently verified resources", () => {
    const manifest = createWorkspaceManifest([
      entry("state", "generation-history", "jobs", 200),
      entry("blob", "image:image:history-result", "result", 800),
    ]);
    const preflight = createMigrationPreflight(manifest, createWorkspaceManifest([]));
    expect(preflight.inventory.counts.state).toBe(1);
    expect(preflight.inventory.counts.blob).toBe(1);
    expect(preflight.pendingBytes).toBe(1000);
  });
});
