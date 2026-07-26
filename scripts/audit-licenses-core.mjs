export function directDependencyNames(manifest, auditedDevDependencies = []) {
  const runtime = manifest?.dependencies && typeof manifest.dependencies === "object"
    ? Object.keys(manifest.dependencies)
    : [];
  const development = new Set(
    manifest?.devDependencies && typeof manifest.devDependencies === "object"
      ? Object.keys(manifest.devDependencies)
      : [],
  );
  const selectedDevelopment = auditedDevDependencies.filter((name) => development.has(name));
  return [...new Set([...runtime, ...selectedDevelopment])].sort();
}
