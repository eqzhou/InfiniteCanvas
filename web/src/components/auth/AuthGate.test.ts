import { describe, expect, test } from "bun:test";
import {
  createScopeReadyCoordinator,
  isGuestIdentity,
  requiresLoginWall,
  revealAuthBeforeWorkspaceReady,
  shouldOfferLogin,
  transitionWorkspaceIdentity,
} from "./AuthGate";

describe("AuthGate workspace identity transitions", () => {
  test("reveals authenticated UI without waiting for workspace hydration", async () => {
    const events: string[] = [];
    let finishHydration!: () => void;
    const hydration = new Promise<void>((resolve) => { finishHydration = resolve; });

    revealAuthBeforeWorkspaceReady(
      "authenticated",
      (status) => { events.push(`status:${status}`); },
      async () => {
        events.push("hydrate:start");
        await hydration;
        events.push("hydrate:done");
      },
    );

    expect(events[0]).toBe("status:authenticated");
    await Promise.resolve();
    expect(events).toEqual(["status:authenticated", "hydrate:start"]);
    finishHydration();
    await hydration;
    await Promise.resolve();
    expect(events).toContain("hydrate:done");
  });

  test("keeps the authenticated UI visible when workspace hydration fails", async () => {
    const statuses: string[] = [];
    const errors: unknown[] = [];
    revealAuthBeforeWorkspaceReady(
      "authenticated",
      (status) => { statuses.push(status); },
      async () => { throw new Error("project save failed"); },
      (error) => { errors.push(error); },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toEqual(["authenticated"]);
    expect(errors).toHaveLength(1);
  });

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

describe("guest bootstrap status", () => {
  test("synthetic guest is not treated as authenticated for capability checks", () => {
    // Mirrors AuthGate bootstrap: guest identity keeps login available.
    expect(shouldOfferLogin("open", guestAccount, false)).toBe(true);
    expect(isGuestIdentity({ ...guestAccount, guest: true })).toBe(true);
  });
});



describe("login wall enforcement", () => {
  test("requires a login wall for guests when accounts are enabled", () => {
    expect(requiresLoginWall("open", null, false)).toBe(true);
    expect(requiresLoginWall("open", guestAccount, false)).toBe(true);
    expect(requiresLoginWall("login_required", null, false)).toBe(true);
  });

  test("does not wall off signed-in users or auth-off local admins", () => {
    expect(requiresLoginWall("authenticated", signedInAccount, false)).toBe(false);
    expect(requiresLoginWall("open", null, true)).toBe(false);
    expect(requiresLoginWall("loading", null, false)).toBe(false);
  });
});
