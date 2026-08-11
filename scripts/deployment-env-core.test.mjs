import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  documentedEnvNames,
  readEnvNames,
  undocumentedEnvNames,
  unforwardedEnvNames,
} from "./deployment-env-core.mjs";

const root = new URL("..", import.meta.url).pathname;

function goSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...goSources(path));
    else if (entry.name.endsWith(".go")) out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

test("readEnvNames collects OPENBOARD_* reads and skips tests", () => {
  assert.deepEqual(readEnvNames([
    { path: "a.go", text: 'os.Getenv("OPENBOARD_TOKEN"); os.Getenv("OPENBOARD_DATA")' },
    { path: "a_test.go", text: 'os.Getenv("OPENBOARD_ONLY_IN_TESTS")' },
    { path: "b.go", text: 'os.Getenv("HOME"); os.Getenv("OPENBOARD_TOKEN")' },
  ]), ["OPENBOARD_DATA", "OPENBOARD_TOKEN"]);
});

test("documentedEnvNames counts commented-out sample entries", () => {
  // A commented example still tells an operator the setting exists.
  assert.deepEqual(documentedEnvNames([
    "OPENBOARD_TOKEN=",
    "# OPENBOARD_PUBLIC_BASE_URL=https://example.com",
    "# a prose comment",
    "NOT_OURS=1",
  ].join("\n")), ["OPENBOARD_PUBLIC_BASE_URL", "OPENBOARD_TOKEN"]);
});

test("undocumentedEnvNames honours the exemption list", () => {
  assert.deepEqual(
    undocumentedEnvNames(["OPENBOARD_A", "OPENBOARD_B", "OPENBOARD_C"], ["OPENBOARD_A"], { OPENBOARD_B: "why" }),
    ["OPENBOARD_C"],
  );
});

test("every server-read setting is discoverable from .env.example", () => {
  // The regression this guards: the server reads OPENBOARD_PUBLIC_BASE_URL in
  // three places — Seedance reference URLs, OAuth redirects and media
  // reference tokens — but the sample never mentioned it, so an operator had
  // no way to learn it existed short of reading the Go source.
  const read = readEnvNames(goSources(join(root, "server")));
  const documented = documentedEnvNames(readFileSync(join(root, ".env.example"), "utf8"));
  assert.deepEqual(undocumentedEnvNames(read, documented), []);
});

test("every documented setting reaches the container", () => {
  // A sample entry that compose never forwards is worse than no entry: the
  // operator sets it and nothing happens.
  const documented = documentedEnvNames(readFileSync(join(root, ".env.example"), "utf8"));
  const compose = readFileSync(join(root, "compose.yaml"), "utf8");
  // These configure the host side of Compose itself rather than the container.
  const hostOnly = ["OPENBOARD_PORT", "OPENBOARD_BIND", "OPENBOARD_POSTGRES_PASSWORD", "OPENBOARD_REDIS_PASSWORD"];
  assert.deepEqual(unforwardedEnvNames(documented, compose, hostOnly), []);
});

test("the deployment sample documents bounded film resource controls", () => {
  const documented = documentedEnvNames(readFileSync(join(root, ".env.example"), "utf8"));
  for (const name of [
    "OPENBOARD_FFMPEG_PATH",
    "OPENBOARD_FFPROBE_PATH",
    "OPENBOARD_PDFTOTEXT_PATH",
    "OPENBOARD_PDFTOTEXT_TIMEOUT",
    "OPENBOARD_PDFTOTEXT_MAX_OUTPUT_BYTES",
    "OPENBOARD_PDF_SANDBOX_PATH",
    "OPENBOARD_FILM_IMPORT_MAX_BYTES",
    "OPENBOARD_FILM_RENDER_TIMEOUT_SECONDS",
  ]) {
    assert.ok(documented.includes(name), `${name} must be documented`);
  }
});

test("incremental feature gates are documented and forwarded to the container", () => {
  const documented = documentedEnvNames(readFileSync(join(root, ".env.example"), "utf8"));
  const compose = readFileSync(join(root, "compose.yaml"), "utf8");
  for (const name of [
    "OPENBOARD_WEBDAV_MEDIA",
    "OPENBOARD_ADVANCED_VOICE",
    "OPENBOARD_LOCAL_WORKFLOWS",
    "OPENBOARD_STYLE_EXTRACTION",
    "OPENBOARD_FILM_STAGE_WAIVER",
  ]) {
    assert.ok(documented.includes(name), `${name} must be documented`);
    assert.ok(compose.includes(`${name}:`), `${name} must reach the container`);
  }
});
