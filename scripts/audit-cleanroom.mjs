import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const roots = ["web/src", "web/public", "server", "third_party"];
const forbidden = [
  /github\.com\/basketikun\/infinite-canvas/i,
  /basketikun\/infinite-canvas/i,
  /openboard\/infinite-canvas/i,
];
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".go", ".css", ".html", ".svg", ".json"]);
const findings = [];

async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (textExtensions.has(path.slice(path.lastIndexOf(".")))) {
      const source = await readFile(path, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) findings.push({ path: path.slice(root.length + 1), pattern: String(pattern) });
      }
    }
  }
}

for (const relative of roots) await walk(join(root, relative));
if (findings.length) {
  console.error("Clean-room audit failed:");
  for (const finding of findings) console.error(`- ${finding.path}: ${finding.pattern}`);
  process.exitCode = 1;
} else {
  console.log("Clean-room implementation scan passed: no reference-source identifiers found in implementation/assets.");
}
