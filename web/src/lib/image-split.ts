export function normalizeSplitGuides(values: number[]): number[] {
  const rounded = values
    .filter(Number.isFinite)
    .map((value) => Math.round(value * 10_000) / 10_000)
    .filter((value) => value >= 0.01 && value <= 0.99)
    .sort((left, right) => left - right);
  return rounded.filter((value, index) => index === 0 || value - rounded[index - 1]! >= 0.001);
}

export function splitSegments(values: number[]): Array<{ start: number; end: number }> {
  const points = [0, ...normalizeSplitGuides(values), 1];
  return points.slice(0, -1).map((start, index) => ({ start, end: points[index + 1]! }));
}

export type SplitCell = {
  index: number;
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export function buildSplitCells(width: number, height: number, vertical: number[], horizontal: number[]): SplitCell[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 65_535 || height > 65_535) {
    throw new Error("Invalid source image dimensions");
  }
  const columns = splitSegments(vertical);
  const rows = splitSegments(horizontal);
  const result: SplitCell[] = [];
  for (const [row, ySegment] of rows.entries()) {
    for (const [column, xSegment] of columns.entries()) {
      const x = Math.round(xSegment.start * width);
      const y = Math.round(ySegment.start * height);
      const endX = Math.round(xSegment.end * width);
      const endY = Math.round(ySegment.end * height);
      result.push({ index: result.length, row, column, x, y, width: Math.max(1, endX - x), height: Math.max(1, endY - y) });
    }
  }
  return result;
}
