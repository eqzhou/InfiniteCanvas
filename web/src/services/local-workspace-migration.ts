export type MigrationResourceKind = "project" | "state" | "secret" | "blob";

export type WorkspaceManifestEntry = {
  kind: MigrationResourceKind;
  id: string;
  fingerprint: string;
  bytes: number;
  version?: string;
};

export type WorkspaceManifest = {
  version: 1;
  fingerprint: string;
  entries: WorkspaceManifestEntry[];
};

export type LocalWorkspaceInventory = {
  version: 1;
  resourceCount: number;
  totalBytes: number;
  counts: Record<MigrationResourceKind, number>;
  manifest: WorkspaceManifest;
};

export type MigrationOperation = {
  id: string;
  entry: WorkspaceManifestEntry;
  expectedVersion: string | null;
};

export type MigrationConflict = {
  local: WorkspaceManifestEntry;
  remote: WorkspaceManifestEntry;
};

export type WorkspaceMigrationPlan = {
  operations: MigrationOperation[];
  alreadyPresent: WorkspaceManifestEntry[];
  conflicts: MigrationConflict[];
};

export type LocalWorkspaceMigrationPreflight = WorkspaceMigrationPlan & {
  inventory: LocalWorkspaceInventory;
  pendingBytes: number;
};

export type MigrationBatch = {
  id: string;
  bytes: number;
  operations: MigrationOperation[];
};

export type MigrationJournalStatus =
  | "inventory"
  | "planned"
  | "transferring"
  | "verifying"
  | "verified"
  | "cleaning"
  | "complete"
  | "conflict"
  | "cancelled"
  | "failed";

export type MigrationJournal = {
  version: 1;
  manifestFingerprint: string;
  status: MigrationJournalStatus;
  completedOperationIds: string[];
  error?: string;
};

export type MigrationBatchLimits = {
  maxItems: number;
  maxBytes: number;
};

const DEFAULT_BATCH_LIMITS: MigrationBatchLimits = {
  maxItems: 20,
  maxBytes: 16 * 1024 * 1024,
};

const STATUS_TRANSITIONS: Record<MigrationJournalStatus, readonly MigrationJournalStatus[]> = {
  inventory: ["planned", "failed"],
  planned: ["transferring", "verifying", "conflict", "cancelled", "failed"],
  transferring: ["transferring", "verifying", "conflict", "cancelled", "failed"],
  verifying: ["verified", "cancelled", "failed"],
  verified: ["cleaning", "cancelled", "failed"],
  cleaning: ["complete", "cancelled", "failed"],
  complete: [],
  conflict: ["planned", "conflict", "failed"],
  cancelled: ["planned", "cancelled", "failed"],
  failed: ["planned", "failed"],
};

function stableValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("migration fingerprint contains a non-finite number");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "undefined") return '"__undefined__"';
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (typeof value !== "object") throw new Error("migration fingerprint contains an unsupported value");
  if (seen.has(value)) throw new Error("migration fingerprint contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableValue(item, seen)).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item, seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

export function fingerprintBytes(bytes: Uint8Array): string {
  return fnv1a(bytes);
}

export function fingerprintValue(value: unknown): string {
  return fnv1a(new TextEncoder().encode(stableValue(value, new Set())));
}

export function canonicalizeMigrationJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("migration resource is not JSON serializable");
  return JSON.parse(encoded) as T;
}

function validateManifestEntry(entry: WorkspaceManifestEntry): WorkspaceManifestEntry {
  if (!entry || !["project", "state", "secret", "blob"].includes(entry.kind)) {
    throw new Error("migration manifest entry kind is invalid");
  }
  const id = entry.id.trim();
  if (!id || id.length > 1024) throw new Error("migration manifest entry id is invalid");
  const fingerprint = entry.fingerprint.trim();
  if (!fingerprint || fingerprint.length > 256) {
    throw new Error("migration manifest entry fingerprint is invalid");
  }
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    throw new Error("migration manifest entry byte count is invalid");
  }
  const version = entry.version?.trim();
  if (version !== undefined && (!version || version.length > 256)) throw new Error("migration manifest version is invalid");
  return { kind: entry.kind, id, fingerprint, bytes: entry.bytes, ...(version ? { version } : {}) };
}

function resourceIdentity(entry: Pick<WorkspaceManifestEntry, "kind" | "id">): string {
  return `${entry.kind}:${entry.id}`;
}

export function createWorkspaceManifest(entries: readonly WorkspaceManifestEntry[]): WorkspaceManifest {
  const normalized = entries.map(validateManifestEntry)
    .sort((left, right) => resourceIdentity(left).localeCompare(resourceIdentity(right)));
  const seen = new Set<string>();
  for (const item of normalized) {
    const identity = resourceIdentity(item);
    if (seen.has(identity)) throw new Error(`duplicate migration manifest resource: ${identity}`);
    seen.add(identity);
  }
  return {
    version: 1,
    fingerprint: fingerprintValue(normalized),
    entries: normalized.map((item) => ({ ...item })),
  };
}

export function createLocalWorkspaceInventory(manifest: WorkspaceManifest): LocalWorkspaceInventory {
  const counts: Record<MigrationResourceKind, number> = { project: 0, state: 0, secret: 0, blob: 0 };
  let totalBytes = 0;
  for (const item of manifest.entries) {
    counts[item.kind] += 1;
    totalBytes += item.bytes;
  }
  return {
    version: 1,
    resourceCount: manifest.entries.length,
    totalBytes,
    counts,
    manifest,
  };
}

export function planWorkspaceMigration(
  local: WorkspaceManifest,
  remote: WorkspaceManifest,
): WorkspaceMigrationPlan {
  const remoteByIdentity = new Map(remote.entries.map((item) => [resourceIdentity(item), item]));
  const operations: MigrationOperation[] = [];
  const alreadyPresent: WorkspaceManifestEntry[] = [];
  const conflicts: MigrationConflict[] = [];
  for (const item of local.entries) {
    const remoteEntry = remoteByIdentity.get(resourceIdentity(item));
    if (!remoteEntry) {
      operations.push({ id: fingerprintValue([item.kind, item.id, item.fingerprint]), entry: { ...item }, expectedVersion: null });
    } else if (remoteEntry.fingerprint === item.fingerprint) {
      alreadyPresent.push({ ...item });
    } else {
      conflicts.push({ local: { ...item }, remote: { ...remoteEntry } });
    }
  }
  return { operations, alreadyPresent, conflicts };
}

export function createMigrationPreflight(
  local: WorkspaceManifest,
  remote: WorkspaceManifest,
): LocalWorkspaceMigrationPreflight {
  const plan = planWorkspaceMigration(local, remote);
  return {
    ...plan,
    inventory: createLocalWorkspaceInventory(local),
    pendingBytes: plan.operations.reduce((total, operation) => total + operation.entry.bytes, 0),
  };
}

function validateLimits(limits: MigrationBatchLimits): void {
  if (!Number.isSafeInteger(limits.maxItems) || limits.maxItems < 1 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error("migration batch limits are invalid");
  }
}

export function planMigrationBatches(
  operations: readonly MigrationOperation[],
  completedOperationIds: ReadonlySet<string> = new Set(),
  limits: MigrationBatchLimits = DEFAULT_BATCH_LIMITS,
): MigrationBatch[] {
  validateLimits(limits);
  const remaining = operations.filter(({ id }) => !completedOperationIds.has(id));
  const batches: MigrationBatch[] = [];
  let current: MigrationOperation[] = [];
  let bytes = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push({
      id: fingerprintValue(current.map(({ id }) => id)),
      bytes,
      operations: current.map((operation) => ({ ...operation, entry: { ...operation.entry } })),
    });
    current = [];
    bytes = 0;
  };
  for (const operation of remaining) {
    const operationBytes = operation.entry.bytes;
    if (current.length && (current.length >= limits.maxItems || bytes + operationBytes > limits.maxBytes)) flush();
    current.push(operation);
    bytes += operationBytes;
    if (current.length >= limits.maxItems || bytes >= limits.maxBytes) flush();
  }
  flush();
  return batches;
}

export function createMigrationJournal(manifestFingerprint: string): MigrationJournal {
  if (!manifestFingerprint.trim()) throw new Error("migration journal manifest fingerprint is required");
  return {
    version: 1,
    manifestFingerprint,
    status: "inventory",
    completedOperationIds: [],
  };
}

export function advanceMigrationJournal(
  journal: MigrationJournal,
  status: MigrationJournalStatus,
  patch: Partial<Pick<MigrationJournal, "completedOperationIds" | "error">> = {},
): MigrationJournal {
  if (!STATUS_TRANSITIONS[journal.status].includes(status)) {
    throw new Error(`invalid migration journal transition: ${journal.status} -> ${status}`);
  }
  const completedOperationIds = patch.completedOperationIds ?? journal.completedOperationIds;
  return {
    ...journal,
    status,
    completedOperationIds: [...new Set(completedOperationIds)].sort(),
    ...(patch.error === undefined ? { error: journal.error } : { error: patch.error }),
  };
}

function manifestContains(remote: WorkspaceManifest, expected: WorkspaceManifest): boolean {
  const remoteByIdentity = new Map(remote.entries.map((item) => [resourceIdentity(item), item]));
  return expected.entries.every((item) => {
    const remoteItem = remoteByIdentity.get(resourceIdentity(item));
    return remoteItem?.fingerprint === item.fingerprint;
  });
}

export type ExecuteWorkspaceMigrationOptions = {
  localManifest: WorkspaceManifest;
  journal?: MigrationJournal;
  loadRemoteManifest: () => Promise<WorkspaceManifest>;
  applyBatch: (batch: MigrationBatch) => Promise<void>;
  clearLocal: () => Promise<void>;
  signal?: AbortSignal;
  saveJournal?: (journal: MigrationJournal) => Promise<void>;
  limits?: MigrationBatchLimits;
};

export type ExecuteWorkspaceMigrationResult = {
  status: "complete" | "conflict" | "cancelled" | "verification-failed" | "failed";
  plan: WorkspaceMigrationPlan;
  journal: MigrationJournal;
};

export async function executeWorkspaceMigration(
  options: ExecuteWorkspaceMigrationOptions,
): Promise<ExecuteWorkspaceMigrationResult> {
  const saveJournal = options.saveJournal ?? (async () => undefined);
  let journal = options.journal?.manifestFingerprint === options.localManifest.fingerprint
    ? { ...options.journal, completedOperationIds: [...options.journal.completedOperationIds] }
    : createMigrationJournal(options.localManifest.fingerprint);
  if (journal.status === "verifying" || journal.status === "verified" ||
      journal.status === "cleaning" || journal.status === "complete") {
    journal = {
      ...journal,
      status: "failed",
      error: "local resources remain after an interrupted migration",
    };
  }
  let plan: WorkspaceMigrationPlan = { operations: [], alreadyPresent: [], conflicts: [] };
  try {
    const remote = await options.loadRemoteManifest();
    plan = planWorkspaceMigration(options.localManifest, remote);
    if (journal.status === "inventory" || journal.status === "failed" ||
        journal.status === "conflict" || journal.status === "cancelled") {
      journal = advanceMigrationJournal(journal, "planned", { error: "" });
      await saveJournal(journal);
    }
    if (plan.conflicts.length) {
      journal = advanceMigrationJournal(journal, "conflict", { error: "remote resources conflict with local migration" });
      await saveJournal(journal);
      return { status: "conflict", plan, journal };
    }
    const stopIfCancelled = async (): Promise<ExecuteWorkspaceMigrationResult | null> => {
      if (!options.signal?.aborted) return null;
      journal = advanceMigrationJournal(journal, "cancelled", { error: "migration cancelled by user" });
      await saveJournal(journal);
      return { status: "cancelled", plan, journal };
    };
    const cancelledBeforeTransfer = await stopIfCancelled();
    if (cancelledBeforeTransfer) return cancelledBeforeTransfer;
    const completed = new Set(journal.completedOperationIds);
    for (const operation of plan.operations) completed.delete(operation.id);
    const batches = planMigrationBatches(plan.operations, completed, options.limits);
    if (batches.length && journal.status !== "transferring") {
      journal = advanceMigrationJournal(journal, "transferring");
      await saveJournal(journal);
    }
    for (const batch of batches) {
      const cancelledBeforeBatch = await stopIfCancelled();
      if (cancelledBeforeBatch) return cancelledBeforeBatch;
      await options.applyBatch(batch);
      for (const operation of batch.operations) completed.add(operation.id);
      journal = advanceMigrationJournal(journal, "transferring", {
        completedOperationIds: [...completed],
      });
      await saveJournal(journal);
      const cancelledAfterBatch = await stopIfCancelled();
      if (cancelledAfterBatch) return cancelledAfterBatch;
    }
    const cancelledBeforeVerify = await stopIfCancelled();
    if (cancelledBeforeVerify) return cancelledBeforeVerify;
    journal = advanceMigrationJournal(journal, "verifying");
    await saveJournal(journal);
    const verifiedRemote = await options.loadRemoteManifest();
    const cancelledAfterVerify = await stopIfCancelled();
    if (cancelledAfterVerify) return cancelledAfterVerify;
    if (!manifestContains(verifiedRemote, options.localManifest)) {
      journal = advanceMigrationJournal(journal, "failed", { error: "server manifest verification failed" });
      await saveJournal(journal);
      return { status: "verification-failed", plan, journal };
    }
    journal = advanceMigrationJournal(journal, "verified", { error: "" });
    await saveJournal(journal);
    journal = advanceMigrationJournal(journal, "cleaning");
    await saveJournal(journal);
    const cancelledBeforeClear = await stopIfCancelled();
    if (cancelledBeforeClear) return cancelledBeforeClear;
    // Cleanup runs only after the server manifest verification above proved the
    // remote copy is complete, so local data is no longer the only copy. A
    // partial cleanup failure must not be reported as a migration failure:
    // that would tell the user to retry from local data that is already
    // partially removed. Record the cleanup error and still complete.
    let cleanupError = "";
    try {
      await options.clearLocal();
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    journal = advanceMigrationJournal(journal, "complete");
    if (cleanupError) journal = { ...journal, error: cleanupError };
    await saveJournal(journal);
    return { status: "complete", plan, journal };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (journal.status !== "failed") {
      journal = advanceMigrationJournal(journal, "failed", { error: message });
      await saveJournal(journal);
    }
    return { status: "failed", plan, journal };
  }
}
