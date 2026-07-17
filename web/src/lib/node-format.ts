export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 72;
export const DEFAULT_FONT_SIZE = 14;
export const MAX_NODE_TITLE_LENGTH = 500;

export function adjustFontSize(current: number | undefined, delta: number): number {
  const value = Number.isFinite(current) ? current! : DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value + delta));
}

export function normalizeNodeTitle(value: string): string {
  return value.trim().slice(0, MAX_NODE_TITLE_LENGTH);
}
