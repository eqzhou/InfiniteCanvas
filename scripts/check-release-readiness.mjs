import { readFile } from "node:fs/promises";
import process from "node:process";

const auditPath = new URL("../docs/RELEASE_AUDIT.md", import.meta.url);
const source = await readFile(auditPath, "utf8");
const pending = [];
let currentPending = false;
for (const line of source.split("\n")) {
  const item = line.match(/^- \[ \] (.+)$/)?.[1];
  if (item) {
    pending.push(item.trim());
    currentPending = true;
  } else if (/^- \[[xX ]\]/.test(line)) {
    currentPending = false;
  } else if (/^ {2,}\S/.test(line) && currentPending && pending.length) {
    pending[pending.length - 1] += ` ${line.trim()}`;
  }
}

if (pending.length) {
  console.error(`Release readiness blocked: ${pending.length} audit item(s) remain.`);
  for (const item of pending) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log("Release readiness audit is complete.");
}
