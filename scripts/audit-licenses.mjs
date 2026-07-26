import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { directDependencyNames } from "./audit-licenses-core.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const bundledNotices = new Map([
  ["@esbuild/darwin-arm64", "third_party/licenses/@esbuild-darwin-arm64-0.28.1-MIT.txt"],
  ["@rollup/rollup-darwin-arm64", "third_party/licenses/@rollup-rollup-darwin-arm64-4.62.2-MIT.txt"],
]);
const webManifest = JSON.parse(await readFile(resolve(root, "web", "package.json"), "utf8"));
const packages = directDependencyNames(webManifest, ["@playwright/test", "@types/three", "typescript", "vite"]);
const expected = new Map([
  ["react", "MIT"], ["react-dom", "MIT"], ["react-router", "MIT"],
  ["zustand", "MIT"], ["lucide-react", "ISC"], ["nanoid", "MIT"],
  ["clsx", "MIT"], ["html-to-image", "MIT"], ["idb-keyval", "Apache-2.0"],
  ["react-markdown", "MIT"], ["remark-gfm", "MIT"],
  ["three", "MIT"], ["@types/three", "MIT"],
]);
const failures = [];
const rows = [];
for (const name of packages) {
  try {
    const path = resolve(root, "web", "node_modules", name, "package.json");
    const pkg = JSON.parse(await readFile(path, "utf8"));
    const license = typeof pkg.license === "string" ? pkg.license : "UNKNOWN";
    rows.push({ name, version: pkg.version ?? "unknown", license });
    if (expected.has(name) && expected.get(name) !== license) failures.push(`${name}: expected ${expected.get(name)}, got ${license}`);
    if (license === "UNKNOWN") failures.push(`${name}: missing license metadata`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.table(rows);
if (failures.length) {
  console.error("License audit failed:\n" + failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Direct dependency license metadata is present. Review transitive dependencies and shipped browser/container binaries separately.");
}

async function collectPackageManifests(directory, result = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectPackageManifests(path, result);
    else if (entry.name === "package.json") result.push(path);
  }
  return result;
}

const manifests = await collectPackageManifests(resolve(root, "web", "node_modules"));
const components = [];
const noticeRows = [];
for (const path of manifests) {
  try {
    const pkg = JSON.parse(await readFile(path, "utf8"));
    const license = typeof pkg.license === "string" ? pkg.license : undefined;
    if (!pkg.name || !pkg.version || !license) continue;
    const packageDir = dirname(path);
    let noticeFile = null;
    for (const candidate of ["LICENSE", "LICENCE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT.txt", "COPYING", "NOTICE"]) {
      try { await readFile(resolve(packageDir, candidate), "utf8"); noticeFile = candidate; break; } catch { /* continue */ }
    }
    const bundledNotice = bundledNotices.get(pkg.name);
    noticeRows.push({
      name: pkg.name,
      version: pkg.version,
      license,
      noticeFile: noticeFile ?? (bundledNotice ? `bundled:${bundledNotice}` : "MISSING"),
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "UNKNOWN",
      homepage: typeof pkg.homepage === "string" ? pkg.homepage : "UNKNOWN",
    });
    components.push({
      "SPDXID": `SPDXRef-${String(pkg.name).replace(/[^A-Za-z0-9.-]/g, "-")}-${pkg.version}`,
      name: pkg.name,
      versionInfo: pkg.version,
      licenseConcluded: license,
      downloadLocation: "NOASSERTION",
    });
  } catch { /* Ignore malformed tool metadata; direct audit above remains strict. */ }
}
const unique = [...new Map(components.map((item) => [item.SPDXID, item])).values()];
for (const [packageName, noticePath] of bundledNotices) {
  try { await readFile(resolve(root, noticePath), "utf8"); }
  catch { failures.push(`${packageName}: bundled notice missing at ${noticePath}`); }
}
await mkdir(resolve(root, "docs"), { recursive: true });
await writeFile(resolve(root, "docs", "SBOM.spdx.json"), JSON.stringify({
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "OpenBoard web dependency inventory",
  documentNamespace: "https://openboard.local/spdx/openboard-web-0.1.0",
  creationInfo: { created: new Date().toISOString(), creators: ["Tool: OpenBoard audit-licenses.mjs"] },
  packages: unique,
}, null, 2) + "\n");
console.log(`Wrote docs/SBOM.spdx.json with ${unique.length} package records.`);
await writeFile(resolve(root, "docs", "LICENSE_REVIEW.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  packages: noticeRows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
  missingNoticeCount: noticeRows.filter((item) => item.noticeFile === "MISSING").length,
}, null, 2) + "\n");
console.log("Wrote docs/LICENSE_REVIEW.json with package notice-file status.");
