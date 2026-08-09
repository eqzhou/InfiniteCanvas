export function parseCoverageSummary(output) {
  const match = /^All files\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)/m.exec(output);
  if (!match) throw new Error("Bun aggregate coverage summary not found");
  return { functions: Number(match[1]), lines: Number(match[2]) };
}

export function coverageFailures(summary, minimum) {
  return ["functions", "lines"].flatMap((metric) => (
    summary[metric] < minimum
      ? [`${metric} ${summary[metric].toFixed(2)}% < ${minimum.toFixed(2)}%`]
      : []
  ));
}
