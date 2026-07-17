export function dedupeQueries(queries) {
  const unique = new Map();
  for (const query of queries) {
    const key = `${query.ecosystem}\u0000${query.name}\u0000${query.version}`;
    if (!unique.has(key)) unique.set(key, { ...query });
  }
  return [...unique.values()];
}

export function findingsFromBatch(queries, payload) {
  if (!payload || !Array.isArray(payload.results) || payload.results.length !== queries.length) {
    throw new Error("OSV response result count does not match the request");
  }
  return payload.results.flatMap((result, index) => {
    const query = queries[index];
    const vulnerabilities = Array.isArray(result?.vulns) ? result.vulns : [];
    return vulnerabilities
      .filter((item) => item && typeof item.id === "string" && !item.withdrawn)
      .map((item) => ({
        ...query,
        id: item.id,
        summary: typeof item.summary === "string" ? item.summary : "",
      }));
  });
}
