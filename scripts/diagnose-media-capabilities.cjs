#!/usr/bin/env node
const { diagnoseMediaCapabilities, shellExports } = require("./media-capability-core.cjs");

const result = diagnoseMediaCapabilities({}, process.env);
console.error(`[openboard] ${result.diagnostic}`);

if (process.argv.includes("--shell")) {
  process.stdout.write(`${shellExports(result.env)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Missing media tools are an optional-capability result, never a startup gate.
process.exitCode = 0;
