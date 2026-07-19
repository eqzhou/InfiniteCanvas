let runtimeClientId = "";
const OWNER_KEY = "openboard:runtime-owner-id";
const OWNER_LEASE_PREFIX = "openboard:runtime-owner-lease:";
const OWNER_LEASE_REFRESH_MS = 5_000;
const RUNTIME_ID = /^[A-Za-z0-9_-]{1,128}$/;

type RuntimeOwnerStorage = Pick<Storage, "getItem" | "setItem">;
type RuntimeOwnerLeaseStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type RuntimeOwnerLease = { instanceId: string; updatedAt: number };

export function resolveRuntimeOwnerId(
  storage: RuntimeOwnerStorage,
  create: () => string = () => `owner-${crypto.randomUUID().replaceAll("-", "")}`,
): string {
  try {
    const existing = storage.getItem(OWNER_KEY);
    if (existing && RUNTIME_ID.test(existing)) return existing;
    const next = create();
    if (!RUNTIME_ID.test(next)) throw new Error("runtime owner ID is invalid");
    storage.setItem(OWNER_KEY, next);
    return next;
  } catch {
    const fallback = create();
    return RUNTIME_ID.test(fallback) ? fallback : "";
  }
}

function parseLease(raw: string | null): RuntimeOwnerLease | null {
  if (!raw || raw.length > 512) return null;
  try {
    const value = JSON.parse(raw) as Partial<RuntimeOwnerLease>;
    return typeof value.instanceId === "string" && RUNTIME_ID.test(value.instanceId) &&
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? { instanceId: value.instanceId, updatedAt: value.updatedAt }
      : null;
  } catch {
    return null;
  }
}

export function claimRuntimeOwnerLease(
  session: RuntimeOwnerStorage,
  leases: RuntimeOwnerLeaseStorage,
  instanceId: string,
  now = Date.now(),
  create: () => string = () => `owner-${crypto.randomUUID().replaceAll("-", "")}`,
): string {
  let ownerId = resolveRuntimeOwnerId(session, create);
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = parseLease(leases.getItem(`${OWNER_LEASE_PREFIX}${ownerId}`));
      if (current && current.instanceId !== instanceId) {
        ownerId = create();
        if (!RUNTIME_ID.test(ownerId)) throw new Error("runtime owner ID is invalid");
        session.setItem(OWNER_KEY, ownerId);
      }
      const key = `${OWNER_LEASE_PREFIX}${ownerId}`;
      leases.setItem(key, JSON.stringify({ instanceId, updatedAt: now }));
      if (parseLease(leases.getItem(key))?.instanceId === instanceId) break;
    }
  } catch {
    const isolated = create();
    if (RUNTIME_ID.test(isolated)) {
      ownerId = isolated;
      try {
        session.setItem(OWNER_KEY, ownerId);
      } catch {
        // The process-local value still prevents a copied tab from sharing ownership.
      }
    }
  }
  if (!RUNTIME_ID.test(ownerId)) throw new Error("runtime owner ID is invalid");
  return ownerId;
}

export function refreshRuntimeOwnerLease(
  session: RuntimeOwnerStorage,
  leases: RuntimeOwnerLeaseStorage,
  ownerId: string,
  instanceId: string,
  now = Date.now(),
  create: () => string = () => `owner-${crypto.randomUUID().replaceAll("-", "")}`,
): string {
  try {
    const key = `${OWNER_LEASE_PREFIX}${ownerId}`;
    const current = parseLease(leases.getItem(key));
    if (current && current.instanceId !== instanceId) {
      return claimRuntimeOwnerLease(session, leases, instanceId, now, create);
    }
    leases.setItem(key, JSON.stringify({ instanceId, updatedAt: now }));
    if (parseLease(leases.getItem(key))?.instanceId === instanceId) return ownerId;
  } catch {
    return ownerId;
  }
  return claimRuntimeOwnerLease(session, leases, instanceId, now, create);
}

export function releaseRuntimeOwnerLease(
  leases: RuntimeOwnerLeaseStorage,
  ownerId: string,
  instanceId: string,
): void {
  try {
    const key = `${OWNER_LEASE_PREFIX}${ownerId}`;
    if (parseLease(leases.getItem(key))?.instanceId === instanceId) leases.removeItem(key);
  } catch {
    // Best-effort lease cleanup must not break page teardown.
  }
}

const runtimeInstanceId = `tab-${crypto.randomUUID().replaceAll("-", "")}`;
let runtimeOwnerId = typeof sessionStorage === "undefined" || typeof localStorage === "undefined"
  ? `owner-${crypto.randomUUID().replaceAll("-", "")}`
  : claimRuntimeOwnerLease(sessionStorage, localStorage, runtimeInstanceId);

export function startRuntimeOwnerLease(): () => void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return () => undefined;
  const refresh = () => {
    runtimeOwnerId = refreshRuntimeOwnerLease(
      sessionStorage,
      localStorage,
      runtimeOwnerId,
      runtimeInstanceId,
    );
  };
  const release = () => releaseRuntimeOwnerLease(localStorage, runtimeOwnerId, runtimeInstanceId);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === `${OWNER_LEASE_PREFIX}${runtimeOwnerId}`) refresh();
  };
  refresh();
  const timer = window.setInterval(refresh, OWNER_LEASE_REFRESH_MS);
  window.addEventListener("storage", handleStorage);
  window.addEventListener("pagehide", release);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("pagehide", release);
    release();
  };
}

export function setRuntimeClientId(clientId: string): void {
  runtimeClientId = RUNTIME_ID.test(clientId) ? clientId : "";
}

export function getRuntimeOwnerId(): string {
  return runtimeOwnerId;
}

export function getRuntimeClientId(): string {
  return runtimeClientId;
}
