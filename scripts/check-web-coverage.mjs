import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { coverageFailures, parseCoverageSummary } from "./web-coverage-core.mjs";

const MINIMUM_COVERAGE_PERCENT = 80;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("bun", ["test", "--coverage", "src", "benchmarks"], {
  cwd: join(root, "web"),
  encoding: "utf8",
  maxBuffer: 16 << 20,
});

process.stdout.write(result.stdout || "");
process.stdout.write(result.stderr || "");
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

let summary;
try {
  summary = parseCoverageSummary(`${result.stdout || ""}\n${result.stderr || ""}`);
} catch (error) {
  console.error(`[coverage] ${error.message}`);
  process.exit(1);
}
const failures = coverageFailures(summary, MINIMUM_COVERAGE_PERCENT);
if (failures.length) {
  console.error(`[coverage] Web aggregate threshold failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`[coverage] Web aggregate threshold passed: functions=${summary.functions.toFixed(2)}%, lines=${summary.lines.toFixed(2)}%, minimum=${MINIMUM_COVERAGE_PERCENT}%`);
