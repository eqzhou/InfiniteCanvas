import { nowIso, uid } from "@/lib/id";
import { getRuntimeClientId } from "@/services/runtime-identity";

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
  };

const MAX_ACTIVITIES = 100;
const listeners = new Set<() => void>();
let activities: GenerationActivity[] = [];

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
  notify();
}

export function completeGenerationActivity(
  id: string,
  status: Exclude<GenerationActivityStatus, "running">,
  error?: string,
): void {
  const activity = activities.find((item) => item.id === id);
  if (!activity) return;
  publish({
    ...activity,
    status,
    updatedAt: nowIso(),
    error: error?.slice(0, 2_000),
  });
}

export async function runTrackedGeneration<T>(
  input: StartGenerationActivity,
  operation: () => Promise<T>,
): Promise<T> {
  const timestamp = nowIso();
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
    if (!input.deferSuccess) {
      publish({ ...activity, status: "succeeded", updatedAt: nowIso() });
    }
    return result;
  } catch (cause) {
    const cancelled = cause instanceof DOMException && cause.name === "AbortError";
    publish({
      ...activity,
      status: cancelled ? "cancelled" : "failed",
      updatedAt: nowIso(),
      error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 2_000),
    });
    throw cause;
  }
}
