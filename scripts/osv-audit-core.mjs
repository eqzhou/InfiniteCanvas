export function dedupeQueries(queries) {
  const unique = new Map();
  for (const query of queries) {
    const key = [query.ecosystem, query.name, query.version].join("\x1f");
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

/**
 * Extract package import paths that an OSV advisory scopes to (Go ecosystem).
 * Returns null when the advisory applies to the whole module with no import filter.
 */
export function affectedImportPaths(vuln) {
  if (!vuln || typeof vuln !== "object") return null;
  const paths = new Set();
  for (const affected of Array.isArray(vuln.affected) ? vuln.affected : []) {
    const imports = affected?.ecosystem_specific?.imports;
    if (!Array.isArray(imports)) continue;
    for (const entry of imports) {
      if (entry && typeof entry.path === "string" && entry.path) paths.add(entry.path);
    }
  }
  return paths.size ? [...paths] : null;
}

/**
 * Keep findings that either lack an import-path scope, or touch an import we actually use.
 * Advisories that only mention packages outside installedImports are filtered out.
 */
export function filterFindingsByImports(findings, vulnDetailsById, installedImports) {
  const installed = new Set(installedImports);
  return findings.filter((finding) => {
    const detail = vulnDetailsById.get(finding.id);
    const paths = affectedImportPaths(detail);
    if (!paths) return true;
    return paths.some(
      (path) =>
        installed.has(path) ||
        [...installed].some((imp) => imp === path || imp.startsWith(`${path}/`)),
    );
  });
}
