import { describe, expect, test } from "bun:test";
import {
  claimRuntimeOwnerLease,
  refreshRuntimeOwnerLease,
  releaseRuntimeOwnerLease,
  resolveRuntimeOwnerId,
} from "./runtime-identity";

describe("runtime owner identity", () => {
  test("persists a bounded tab owner across reloads without reusing invalid values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const first = resolveRuntimeOwnerId(storage, () => "owner-first");
    const reloaded = resolveRuntimeOwnerId(storage, () => "owner-second");
    expect(reloaded).toBe(first);

    values.set("openboard:runtime-owner-id", "../invalid");
    expect(resolveRuntimeOwnerId(storage, () => "owner-safe")).toBe("owner-safe");
  });

  test("assigns a new owner to a duplicated live tab but permits a released reload", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-shared"]]);
    const leaseValues = new Map<string, string>();
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const leases = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => { leaseValues.set(key, value); },
      removeItem: (key: string) => { leaseValues.delete(key); },
    };
    const first = claimRuntimeOwnerLease(session, leases, "tab-one", 100, () => "owner-new");
    expect(first).toBe("owner-shared");
    const duplicate = claimRuntimeOwnerLease(session, leases, "tab-two", 101, () => "owner-new");
    expect(duplicate).toBe("owner-new");

    releaseRuntimeOwnerLease(leases, duplicate, "tab-two");
    sessionValues.set("openboard:runtime-owner-id", duplicate);
    expect(claimRuntimeOwnerLease(session, leases, "tab-reload", 102, () => "owner-unused"))
      .toBe(duplicate);
  });

  test("never reuses a stale lease owned by another live instance", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-stale"]]);
    const leaseValues = new Map<string, string>([[
      "openboard:runtime-owner-lease:owner-stale",
      JSON.stringify({ instanceId: "tab-old", updatedAt: 1 }),
    ]]);
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const leases = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => { leaseValues.set(key, value); },
      removeItem: (key: string) => { leaseValues.delete(key); },
    };

    expect(claimRuntimeOwnerLease(session, leases, "tab-new", 999_999, () => "owner-new"))
      .toBe("owner-new");
    expect(JSON.parse(leaseValues.get("openboard:runtime-owner-lease:owner-stale") ?? "{}"))
      .toMatchObject({ instanceId: "tab-old" });
  });

  test("a resumed tab changes owner instead of overwriting a newer claimant", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-shared"]]);
    const leaseValues = new Map<string, string>([[
      "openboard:runtime-owner-lease:owner-shared",
      JSON.stringify({ instanceId: "tab-new", updatedAt: 200 }),
    ]]);
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const leases = {
      getItem: (key: string) => leaseValues.get(key) ?? null,
      setItem: (key: string, value: string) => { leaseValues.set(key, value); },
      removeItem: (key: string) => { leaseValues.delete(key); },
    };

    expect(refreshRuntimeOwnerLease(session, leases, "owner-shared", "tab-old", 201, () => "owner-recovered"))
      .toBe("owner-recovered");
    expect(JSON.parse(leaseValues.get("openboard:runtime-owner-lease:owner-shared") ?? "{}"))
      .toMatchObject({ instanceId: "tab-new" });
  });

  test("uses a process-local owner when lease storage is unavailable", () => {
    const sessionValues = new Map<string, string>([["openboard:runtime-owner-id", "owner-copied"]]);
    const session = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const unavailable = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
      removeItem: () => { throw new Error("storage disabled"); },
    };

    expect(claimRuntimeOwnerLease(session, unavailable, "tab-new", 100, () => "owner-isolated"))
      .toBe("owner-isolated");
    expect(sessionValues.get("openboard:runtime-owner-id")).toBe("owner-isolated");
  });
});
