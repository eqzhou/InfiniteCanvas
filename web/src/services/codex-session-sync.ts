import type { CodexSession } from "@/services/local-agent";

export type SharedTurnStatus = "idle" | "running" | "completed" | "failed";
export type CodexSharedState = {
  scopeKey: string;
  profile: string;
  session: CodexSession | null;
  turnStatus: SharedTurnStatus;
  updatedAt: number;
  sourceId: string;
};

const CHANNEL = "openboard:codex-session";
const STORAGE_PREFIX = "openboard:codex-session:";
const SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function shouldResetCodexTranscript(previousId: string | undefined, nextId: string | undefined): boolean {
  return Boolean(nextId && previousId !== nextId);
}

export function statusForCodexSnapshot(
  current: SharedTurnStatus,
  running: boolean,
): SharedTurnStatus {
  if (running) return "running";
  if (current === "running") return "completed";
  return current;
}

function validSession(value: unknown): value is CodexSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return typeof session.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(session.id) &&
    (session.threadId === undefined || typeof session.threadId === "string") &&
    (session.profile === undefined || typeof session.profile === "string") &&
    (session.running === undefined || typeof session.running === "boolean");
}

export function parseCodexSharedState(value: unknown): CodexSharedState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (typeof state.scopeKey !== "string" || !SCOPE_PATTERN.test(state.scopeKey) ||
      typeof state.profile !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(state.profile) ||
      (state.session !== null && !validSession(state.session)) ||
      !["idle", "running", "completed", "failed"].includes(String(state.turnStatus)) ||
      typeof state.updatedAt !== "number" || !Number.isFinite(state.updatedAt) ||
      typeof state.sourceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(state.sourceId)) {
    return null;
  }
  return structuredClone(state) as CodexSharedState;
}

function parseStored(raw: string | null): CodexSharedState | null {
  if (!raw || raw.length > 64 * 1024) return null;
  try {
    return parseCodexSharedState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function createCodexSessionSync(
  profile: string,
  onState: (state: CodexSharedState) => void,
  scopeKey = "default",
): { initial: CodexSharedState | null; publish: (session: CodexSession | null, turnStatus: SharedTurnStatus) => void; close: () => void } {
  if (!SCOPE_PATTERN.test(scopeKey)) throw new Error("Codex session scope is invalid");
  const sourceId = `tab-${crypto.randomUUID().replaceAll("-", "")}`;
  const storageKey = `${STORAGE_PREFIX}${scopeKey}:${profile}`;
  let newest = 0;
  const accept = (value: unknown) => {
    const state = parseCodexSharedState(value);
    if (!state || state.scopeKey !== scopeKey || state.profile !== profile || state.sourceId === sourceId || state.updatedAt < newest) return;
    newest = state.updatedAt;
    onState(state);
  };
  let channel: BroadcastChannel | null = null;
  try {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  if (channel) channel.onmessage = (event) => accept(event.data);
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) accept(parseStored(event.newValue));
  };
  window.addEventListener("storage", onStorage);
  let initial: CodexSharedState | null = null;
  try {
    initial = parseStored(localStorage.getItem(storageKey));
  } catch {
    // BroadcastChannel and this tab's in-memory state remain available.
  }
  if (initial) newest = initial.updatedAt;
  return {
    initial,
    publish(session, turnStatus) {
      const state: CodexSharedState = {
        scopeKey,
        profile,
        session: session ? structuredClone(session) : null,
        turnStatus,
        updatedAt: Math.max(Date.now(), newest + 1),
        sourceId,
      };
      newest = state.updatedAt;
      try {
        localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        // Storage can be disabled or full; publishing still continues in memory and over BroadcastChannel.
      }
      try {
        channel?.postMessage(state);
      } catch {
        // The current tab remains authoritative even if cross-tab messaging is unavailable.
      }
    },
    close() {
      channel?.close();
      window.removeEventListener("storage", onStorage);
    },
  };
}
