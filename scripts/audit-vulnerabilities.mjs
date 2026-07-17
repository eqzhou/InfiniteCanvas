import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { dedupeQueries, findingsFromBatch } from "./osv-audit-core.mjs";

const exec = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);

async function collectNodePackages(directory, queries = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return queries;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectNodePackages(path, queries);
      continue;
    }
    if (entry.name !== "package.json") continue;
    try {
      const pkg = JSON.parse(await readFile(path, "utf8"));
      if (typeof pkg.name === "string" && typeof pkg.version === "string") {
        queries.push({ ecosystem: "npm", name: pkg.name, version: pkg.version });
      }
    } catch {
      // The strict direct dependency/license audit reports malformed manifests.
    }
  }
  return queries;
}

async function collectGoModules() {
  const { stdout } = await exec("go", ["list", "-m", "-f", "{{.Path}}\t{{.Version}}", "all"], {
    cwd: resolve(root, "server"),
    env: { ...process.env, GOSUMDB: "sum.golang.org", GOTOOLCHAIN: "auto" },
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim().split("\n").flatMap((line) => {
    const [name, version] = line.split("\t");
    return name && version ? [{ ecosystem: "Go", name, version }] : [];
  });
}

async function boundedJSON(response, maxBytes) {
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("OSV response is not JSON");
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > maxBytes) throw new Error("OSV response is too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OSV response body is missing");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("OSV response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const queries = dedupeQueries([
  ...await collectNodePackages(resolve(root, "web", "node_modules")),
  ...await collectGoModules(),
]);
if (!queries.length) throw new Error("No installed dependencies were found for OSV audit");

const response = await fetch("https://api.osv.dev/v1/querybatch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    queries: queries.map(({ ecosystem, name, version }) => ({
      package: { ecosystem, name },
      version,
    })),
  }),
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`OSV audit failed: HTTP ${response.status}`);
const findings = findingsFromBatch(queries, await boundedJSON(response, 16 * 1024 * 1024));
if (findings.length) {
  console.error(`OSV audit found ${findings.length} active vulnerability record(s):`);
  for (const item of findings) {
    console.error(`- ${item.id} ${item.ecosystem}:${item.name}@${item.version}${item.summary ? ` - ${item.summary}` : ""}`);
  }
  process.exitCode = 1;
} else {
  console.log(`OSV audit passed for ${queries.length} installed npm and Go package versions.`);
}
