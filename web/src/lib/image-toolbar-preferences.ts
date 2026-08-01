export const IMAGE_TOOLBAR_ACTIONS = [
  "generate",
  "video",
  "reverse",
  "crop",
  "rotate",
  "angle",
  "mask",
  "resize",
  "ai-upscale",
  "split",
  "copy",
  "download",
  "aspect",
] as const;

export type ImageToolbarAction = (typeof IMAGE_TOOLBAR_ACTIONS)[number];

export type ImageToolbarPreferences = {
  version: 1;
  order: ImageToolbarAction[];
  hidden: ImageToolbarAction[];
  showLabels: boolean;
};

const actionSet = new Set<string>(IMAGE_TOOLBAR_ACTIONS);
const mandatoryActions = new Set<ImageToolbarAction>(["copy", "download"]);
export const IMAGE_TOOLBAR_PREFERENCES_VERSION = 1;
// Bound hostile persisted input before iterating it.
const maxPersistedActionEntries = IMAGE_TOOLBAR_ACTIONS.length * 4;

export const DEFAULT_IMAGE_TOOLBAR_PREFERENCES: Readonly<ImageToolbarPreferences> = Object.freeze({
  version: IMAGE_TOOLBAR_PREFERENCES_VERSION,
  order: Object.freeze([...IMAGE_TOOLBAR_ACTIONS]) as unknown as ImageToolbarAction[],
  hidden: Object.freeze([]) as unknown as ImageToolbarAction[],
  showLabels: false,
});

function actionList(value: unknown): ImageToolbarAction[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > maxPersistedActionEntries) return null;
  const seen = new Set<ImageToolbarAction>();
  const output: ImageToolbarAction[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !actionSet.has(item)) continue;
    const action = item as ImageToolbarAction;
    if (seen.has(action)) continue;
    seen.add(action);
    output.push(action);
  }
  return output;
}

function defaultPreferences(): ImageToolbarPreferences {
  return {
    version: IMAGE_TOOLBAR_PREFERENCES_VERSION,
    order: [...IMAGE_TOOLBAR_ACTIONS],
    hidden: [],
    showLabels: false,
  };
}

export function normalizeImageToolbarPreferences(value: unknown): ImageToolbarPreferences {
  if (!value || typeof value !== "object") {
    return defaultPreferences();
  }
  const candidate = value as Record<string, unknown>;
  // Version 0 (unversioned) is the pre-release shape and stays readable; any
  // newer/unknown version was written by a future build and is not safe to
  // reinterpret, so it falls back to defaults instead.
  const version = candidate.version === undefined ? 0 : candidate.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 ||
    version > IMAGE_TOOLBAR_PREFERENCES_VERSION) {
    return defaultPreferences();
  }
  const order = actionList(candidate.order);
  const hidden = actionList(candidate.hidden);
  if (!order || !hidden) {
    return defaultPreferences();
  }
  const completeOrder = [...order, ...IMAGE_TOOLBAR_ACTIONS.filter((action) => !order.includes(action))];
  return {
    version: IMAGE_TOOLBAR_PREFERENCES_VERSION,
    order: completeOrder,
    hidden: hidden.filter((action) => !mandatoryActions.has(action)),
    showLabels: candidate.showLabels === true,
  };
}

export function orderedVisibleImageActions(value: unknown): ImageToolbarAction[] {
  const preferences = normalizeImageToolbarPreferences(value);
  const hidden = new Set(preferences.hidden);
  return preferences.order.filter((action) => mandatoryActions.has(action) || !hidden.has(action));
}

export function orderedVisiblePanoramaActions(value: unknown): ImageToolbarAction[] {
  return orderedVisibleImageActions(value).filter((action) => action === "copy" || action === "download");
}
