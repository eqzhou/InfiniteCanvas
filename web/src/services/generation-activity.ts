import { nowIso, uid } from "@/lib/id";
import { getRuntimeClientId } from "@/services/runtime-identity";
import { getSessionToken } from "@/services/auth-session";
import { getAICallLogClientReport, reportAICallLog } from "@/services/ai-call-logs";

export type GenerationActivityKind = "text" | "image" | "video" | "audio";
export type GenerationActivityStatus = "running" | "succeeded" | "failed" | "cancelled";
export type GenerationActivitySurface = "canvas" | "image-workbench" | "video-workbench" | "other";
export type GenerationActivity = {
  id: string;
  kind: GenerationActivityKind;
  status: GenerationActivityStatus;
  surface: GenerationActivitySurface;
  prompt: string;
  model?: string;
  providerId?: string;
  ownerClientId?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
};

type StartGenerationActivity = Pick<GenerationActivity, "kind" | "prompt"> &
  Partial<Pick<GenerationActivity, "id" | "surface" | "model" | "providerId">> & {
    deferSuccess?: boolean;
    reportClient?: boolean;
  };

const MAX_ACTIVITIES = 100;
const listeners = new Set<() => void>();
let activities: GenerationActivity[] = [];

/**
 * Provider duration for `deferSuccess` runs whose provider call already
 * succeeded but whose audit row is still owed, keyed by activity id.
 *
 * The deferral postpones activity completion until media persistence finishes,
 * so the audit row has to be uploaded by `completeGenerationActivity` instead.
 * Entries are consumed on completion; failures reported inline by
 * `runTrackedGeneration` never enter the map, which is what keeps the caller's
 * follow-up `completeGenerationActivity("failed")` from double-reporting.
 */
const deferredReportDurations = new Map<string, number>();

function currentSurface(): GenerationActivitySurface {
  if (typeof window === "undefined") return "canvas";
  if (window.location.pathname === "/workbench/image") return "image-workbench";
  if (window.location.pathname === "/workbench/video") return "video-workbench";
  if (window.location.pathname === "/") return "canvas";
  return "other";
}

function cloneActivities(): GenerationActivity[] {
  return activities.map((item) => ({ ...item }));
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(activity: GenerationActivity): void {
  activities = [{ ...activity }, ...activities.filter((item) => item.id !== activity.id)].slice(0, MAX_ACTIVITIES);
  notify();
}

export function getGenerationActivities(): GenerationActivity[] {
  return cloneActivities();
}

export function subscribeGenerationActivities(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearGenerationActivities(): void {
  activities = [];
  deferredReportDurations.clear();
  notify();
}

export function completeGenerationActivity(
  id: string,
  status: Exclude<GenerationActivityStatus, "running">,
  error?: string,
): void {
  const activity = activities.find((item) => item.id === id);
  if (!activity) return;
  const trimmedError = error?.slice(0, 2_000);
  publish({
    ...activity,
    status,
    updatedAt: nowIso(),
    error: trimmedError,
  });
  const durationMs = deferredReportDurations.get(id);
  if (durationMs === undefined) return;
  deferredReportDurations.delete(id);
  maybeReportClientAICall(activity, status, durationMs, trimmedError);
}

let clientReportEnabledCache: { enabled: boolean; expiresAt: number } | null = null;

function canAttemptClientAICallReport(): boolean {
  // Without a session (or process-token bootstrap handled server-side), the
  // report endpoint will 401; skip the network round-trip entirely.
  if (typeof window === "undefined") return false;
  return Boolean(getSessionToken());
}

async function clientReportEnabled(): Promise<boolean> {
  if (!canAttemptClientAICallReport()) return false;
  const now = Date.now();
  if (clientReportEnabledCache && clientReportEnabledCache.expiresAt > now) {
    return clientReportEnabledCache.enabled;
  }
  const policy = await getAICallLogClientReport();
  clientReportEnabledCache = { enabled: Boolean(policy.enabled), expiresAt: now + 30_000 };
  return clientReportEnabledCache.enabled;
}

/** Drop cached admin switch so the next generation re-reads policy promptly. */
export function invalidateAICallLogClientReportCache(): void {
  clientReportEnabledCache = null;
}

function maybeReportClientAICall(
  activity: GenerationActivity,
  status: "succeeded" | "failed" | "cancelled",
  durationMs: number,
  error?: string,
): void {
  void (async () => {
    if (!(await clientReportEnabled())) return;
    await reportAICallLog({
      kind: activity.kind,
      status,
      channelId: activity.providerId,
      channelName: activity.providerId,
      model: activity.model,
      durationMs,
      error,
      request: {
        source: "client-direct",
        surface: activity.surface,
        prompt: activity.prompt.slice(0, 4_000),
        model: activity.model,
        channelId: activity.providerId,
        ownerClientId: activity.ownerClientId,
      },
      response: status === "succeeded" ? { ok: true } : { ok: false },
    });
  })();
}

export async function runTrackedGeneration<T>(
  input: StartGenerationActivity,
  operation: () => Promise<T>,
): Promise<T> {
  const timestamp = nowIso();
  const startedMs = Date.now();
  const activity: GenerationActivity = {
    id: input.id && /^[A-Za-z0-9_-]{1,128}$/.test(input.id) ? input.id : uid("generation"),
    kind: input.kind,
    status: "running",
    surface: input.surface ?? currentSurface(),
    prompt: input.prompt.slice(0, 10_000),
    model: input.model?.slice(0, 500),
    providerId: input.providerId?.slice(0, 500),
    ownerClientId: getRuntimeClientId() || undefined,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  publish(activity);
  try {
    const result = await operation();
    const providerDurationMs = Math.max(0, Date.now() - startedMs);
    if (input.deferSuccess) {
      // The provider call is already billed. Hand the audit row to
      // completeGenerationActivity so media persistence time is excluded.
      if (input.reportClient !== false) {
        if (deferredReportDurations.size >= MAX_ACTIVITIES) {
          const oldest = deferredReportDurations.keys().next();
          if (!oldest.done) deferredReportDurations.delete(oldest.value);
        }
        deferredReportDurations.set(activity.id, providerDurationMs);
      }
    } else {
      publish({ ...activity, status: "succeeded", updatedAt: nowIso() });
      if (input.reportClient !== false) {
        maybeReportClientAICall(activity, "succeeded", providerDurationMs);
      }
    }
    return result;
  } catch (cause) {
    const cancelled = cause instanceof DOMException && cause.name === "AbortError";
    const status = cancelled ? "cancelled" as const : "failed" as const;
    const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_000);
    publish({
      ...activity,
      status,
      updatedAt: nowIso(),
      error,
    });
    deferredReportDurations.delete(activity.id);
    if (input.reportClient !== false) {
      maybeReportClientAICall(activity, status, Math.max(0, Date.now() - startedMs), error);
    }
    throw cause;
  }
}
