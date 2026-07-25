export type WorkflowEntryPosition = Readonly<{ x: number; y: number }>;
export type WorkflowEntryViewport = Readonly<{ width: number; height: number }>;

const MARGIN = 12;
const ENTRY_WIDTH = 176;
const ENTRY_HEIGHT = 48;

export function clampWorkflowEntryPosition(
  position: WorkflowEntryPosition,
  viewport: WorkflowEntryViewport,
): WorkflowEntryPosition {
  return {
    x: Math.min(Math.max(MARGIN, position.x), Math.max(MARGIN, viewport.width - ENTRY_WIDTH - MARGIN)),
    y: Math.min(Math.max(MARGIN, position.y), Math.max(MARGIN, viewport.height - ENTRY_HEIGHT - MARGIN)),
  };
}

export function parseWorkflowEntryPosition(value: string | null): WorkflowEntryPosition | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { x?: unknown; y?: unknown };
    if (typeof parsed.x !== "number" || !Number.isFinite(parsed.x)) return null;
    if (typeof parsed.y !== "number" || !Number.isFinite(parsed.y)) return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

export function defaultWorkflowEntryPosition(viewport: WorkflowEntryViewport): WorkflowEntryPosition {
  return clampWorkflowEntryPosition(
    { x: viewport.width - ENTRY_WIDTH - 24, y: viewport.height - ENTRY_HEIGHT - 24 },
    viewport,
  );
}
