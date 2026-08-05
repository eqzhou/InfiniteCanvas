import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Environment variables the server reads but that do not belong in the
 * deployment sample, with the reason each one is exempt. Anything else the
 * server reads must be documented in `.env.example`, or an operator has no way
 * to discover it short of reading the Go source.
 */
export const DEPLOYMENT_ENV_EXEMPTIONS = Object.freeze({
  OPENBOARD_TEST_DATABASE_URL: "test-only; never read by a running deployment",
  OPENBOARD_E2E_TENANT_TOKEN: "test-only; enables isolated Playwright tenants on loopback",
  OPENBOARD_DATA: "set by compose.yaml to the container data volume",
  OPENBOARD_ADDR: "set by compose.yaml to the in-container listen address",
  OPENBOARD_CODEX_BIN: "local developer agent bridge, not a deployment setting",
  OPENBOARD_CODEX_SKILLS_ROOT: "local developer agent bridge, not a deployment setting",
  OPENBOARD_CLAUDE_BIN: "local developer agent bridge, not a deployment setting",
  OPENBOARD_CLAUDE_PERMISSION_MODE: "local developer agent bridge, not a deployment setting",
  OPENBOARD_CONNECTION_FILE: "local developer agent bridge, not a deployment setting",
});

/** Every `OPENBOARD_*` name the given Go sources read, excluding tests. */
export function readEnvNames(sources) {
  const names = new Set();
  for (const { path, text } of sources) {
    if (path.endsWith("_test.go")) continue;
    for (const match of text.matchAll(/os\.Getenv\("(OPENBOARD_[A-Z0-9_]+)"\)/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** Names documented in an `.env.example`, including commented-out entries. */
export function documentedEnvNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*#?\s*(OPENBOARD_[A-Z0-9_]+)\s*=/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

/** Server-read names an operator cannot discover from the sample. */
export function undocumentedEnvNames(readNames, documentedNames, exemptions = DEPLOYMENT_ENV_EXEMPTIONS) {
  const documented = new Set(documentedNames);
  return readNames.filter((name) => !documented.has(name) && !(name in exemptions));
}

/** Names the sample documents that compose never forwards to the container. */
export function unforwardedEnvNames(documentedNames, composeText, hostOnly) {
  const hostOnlySet = new Set(hostOnly);
  return documentedNames.filter((name) => !hostOnlySet.has(name) && !composeText.includes(`${name}:`));
}

export function readRepoFile(root, relative) {
  return readFileSync(join(root, relative), "utf8");
}
