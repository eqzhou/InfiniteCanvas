import { describe, expect, test } from "bun:test";
import { createMigrationPreflight, createWorkspaceManifest } from "@/services/local-workspace-migration";
import {
  createScopeReadyCoordinator,
  prepareAuthenticatedWorkspace,
  releaseAuthenticatedWorkspace,
  transitionWorkspaceIdentity,
} from "./AuthGate";

describe("AuthGate login migration interactions", () => {
  test("flushes the current workspace before credentials change and hydrates the new scope afterwards", async () => {
    const events: string[] = [];
    await transitionWorkspaceIdentity(
      async () => { events.push("flush:open"); },
      async () => { events.push("credentials:tenant-a"); },
      async () => { events.push("hydrate:tenant-a"); },
    );
    expect(events).toEqual(["flush:open", "credentials:tenant-a", "hydrate:tenant-a"]);
  });

  test("does not change credentials when the current scope cannot be flushed", async () => {
    const events: string[] = [];
    await expect(transitionWorkspaceIdentity(
      async () => { throw new Error("save failed"); },
      async () => { events.push("credentials"); },
      async () => { events.push("hydrate"); },
    )).rejects.toThrow("save failed");
    expect(events).toEqual([]);
  });

  test("runs readiness once per identity scope instead of once per page lifetime", async () => {
    const scopes: string[] = [];
    const ready = createScopeReadyCoordinator(async (scope) => { scopes.push(scope); });

    await ready("open");
    await ready("open");
    await ready("tenant-a");
    await ready("tenant-a");
    await ready("open");

    expect(scopes).toEqual(["open", "tenant-a", "open"]);
  });

  test("waits for an explicit user decision when preflight finds local data", async () => {
    let hydrated = 0;
    const preflight = createMigrationPreflight(
      createWorkspaceManifest([{ kind: "project", id: "project:a", fingerprint: "a", bytes: 10 }]),
      createWorkspaceManifest([]),
    );
    const result = await prepareAuthenticatedWorkspace(
      async () => ({ ...preflight, journal: null }),
      async () => { hydrated += 1; },
    );
    expect(result?.inventory.resourceCount).toBe(1);
    expect(hydrated).toBe(0);
  });

  test("hydrates immediately only when preflight confirms there is no local workspace", async () => {
    let hydrated = 0;
    const result = await prepareAuthenticatedWorkspace(
      async () => null,
      async () => { hydrated += 1; },
    );
    expect(result).toBeNull();
    expect(hydrated).toBe(1);
  });

  test("keep-local releases hydration without migration while completion enters after verified migration", async () => {
    let hydrated = 0;
    let kept = 0;
    await releaseAuthenticatedWorkspace(
      "keep-local",
      async () => { hydrated += 1; },
      () => { kept += 1; },
    );
    expect({ hydrated, kept }).toEqual({ hydrated: 1, kept: 1 });

    await releaseAuthenticatedWorkspace(
      "migration-complete",
      async () => { hydrated += 1; },
      () => { kept += 1; },
    );
    expect({ hydrated, kept }).toEqual({ hydrated: 2, kept: 1 });
  });
});
