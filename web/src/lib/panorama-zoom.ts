const PREVIEW_MIN_ZOOM = 1;
const PREVIEW_MAX_ZOOM = 4;
const VIEWER_MIN_ZOOM = 1;
const VIEWER_MAX_ZOOM = 3;
const MIN_FIELD_OF_VIEW = 35;
const MAX_FIELD_OF_VIEW = 100;

function wheelDirection(deltaY: number): -1 | 0 | 1 {
  if (deltaY < 0) return 1;
  if (deltaY > 0) return -1;
  return 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value * 100) / 100));
}

export function nextPanoramaPreviewZoom(current: number, deltaY: number): number {
  return clamp(current + wheelDirection(deltaY) * 0.2, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM);
}

export function nextPanoramaViewerZoom(current: number, deltaY: number): number {
  return clamp(current + wheelDirection(deltaY) * 0.15, VIEWER_MIN_ZOOM, VIEWER_MAX_ZOOM);
}

export function nextPanoramaFieldOfView(current: number, deltaY: number): number {
  return clamp(current - wheelDirection(deltaY) * 5, MIN_FIELD_OF_VIEW, MAX_FIELD_OF_VIEW);
}
