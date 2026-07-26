import { describe, expect, test } from "bun:test";
import { createMigrationPreflight, createWorkspaceManifest } from "@/services/local-workspace-migration";
import {
  createScopeReadyCoordinator,
  isGuestIdentity,
  prepareAuthenticatedWorkspace,
  releaseAuthenticatedWorkspace,
  shouldOfferLogin,
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

const signedInAccount = {
  id: "u1", tenantId: "t1", email: "a@b.c", displayName: "A",
  role: "owner", credits: 0, status: "active",
};
// `optional` mode synthesizes this instead of answering 401.
const guestAccount = {
  id: "", tenantId: "local", email: "", displayName: "访客",
  role: "guest", credits: 0, status: "active",
};

describe("guest identity", () => {
  test("treats the synthesized guest as not signed in", () => {
    // The server answers /api/auth/me with 200 and a guest user in optional
    // mode. Taking that at face value makes the UI believe someone is signed
    // in, so it offers "sign out" and hides the way to actually sign in.
    expect(isGuestIdentity(guestAccount)).toBe(true);
    expect(isGuestIdentity({ ...guestAccount, guest: true })).toBe(true);
    expect(isGuestIdentity(null)).toBe(true);
  });

  test("treats a real account as signed in", () => {
    expect(isGuestIdentity(signedInAccount)).toBe(false);
  });
});

describe("login entry point availability", () => {
  test("offers login to a guest while accounts are enabled", () => {
    // A guest may read but every write is refused, so the way back to the
    // sign-in form must stay reachable.
    expect(shouldOfferLogin("open", null, false)).toBe(true);
    expect(shouldOfferLogin("open", guestAccount, false)).toBe(true);
  });

  test("hides login once a real user is signed in", () => {
    expect(shouldOfferLogin("authenticated", signedInAccount, false)).toBe(false);
    expect(shouldOfferLogin("open", signedInAccount, false)).toBe(false);
  });

  test("hides login when authentication is disabled entirely", () => {
    // auth_mode=off grants local admin; there is no account to sign into.
    expect(shouldOfferLogin("open", null, true)).toBe(false);
  });

  test("hides login while the gate is deciding or already showing the form", () => {
    expect(shouldOfferLogin("loading", null, false)).toBe(false);
    expect(shouldOfferLogin("login_required", null, false)).toBe(false);
  });
});
