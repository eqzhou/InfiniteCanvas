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
