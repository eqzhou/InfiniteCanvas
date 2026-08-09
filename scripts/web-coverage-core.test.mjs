import assert from "node:assert/strict";
import test from "node:test";
import { coverageFailures, parseCoverageSummary } from "./web-coverage-core.mjs";

test("parses Bun's aggregate function and line coverage", () => {
  const output = [
    "----------------|---------|---------|-------------------",
    "File            | % Funcs | % Lines | Uncovered Line #s",
    "----------------|---------|---------|-------------------",
    "All files       |   83.42 |   82.24 |",
  ].join("\n");
  assert.deepEqual(parseCoverageSummary(output), { functions: 83.42, lines: 82.24 });
});

test("fails each aggregate metric below 80 and rejects a missing summary", () => {
  assert.deepEqual(coverageFailures({ functions: 79.99, lines: 80 }, 80), ["functions 79.99% < 80.00%"]);
  assert.deepEqual(coverageFailures({ functions: 80, lines: 79.5 }, 80), ["lines 79.50% < 80.00%"]);
  assert.throws(() => parseCoverageSummary("833 pass\n0 fail"), /summary not found/);
});
