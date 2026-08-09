import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("container pins distro FFmpeg and exposes exact executable paths", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /ffmpeg=8\.0\.1-r1/);
  assert.match(dockerfile, /OPENBOARD_FFMPEG_PATH=\/usr\/bin\/ffmpeg/);
  assert.match(dockerfile, /OPENBOARD_FFPROBE_PATH=\/usr\/bin\/ffprobe/);
  assert.doesNotMatch(dockerfile, /curl|wget.*ffmpeg/i);
  const notices = read("docs/THIRD_PARTY_NOTICES.md");
  assert.match(notices, /FFmpeg \| 8\.0\.1-r1/);
  assert.match(notices, /GPL-2\.0-or-later AND LGPL-2\.1-or-later/);
});

test("compose forwards media controls and bounds temporary storage", () => {
  const compose = read("compose.yaml");
  assert.match(compose, /OPENBOARD_FFMPEG_PATH:/);
  assert.match(compose, /OPENBOARD_FFPROBE_PATH:/);
  assert.match(compose, /\/tmp:size=512m/);
});

test("CI makes coverage, film Chromium, deployment, and container capability checks explicit", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(read("web/package.json"), /"test:coverage": "node \.\.\/scripts\/check-web-coverage\.mjs"/);
  assert.match(read("scripts/check-web-coverage.mjs"), /MINIMUM_COVERAGE_PERCENT = 80/);
  assert.match(workflow, /Film Chromium E2E/);
  assert.match(workflow, /e2e\/film\.spec\.ts/);
  assert.match(workflow, /audit:deployment-env/);
  assert.match(workflow, /audit:vulnerabilities/);
  assert.match(workflow, /audit:licenses/);
  assert.match(workflow, /audit:cleanroom/);
  assert.match(workflow, /OPENBOARD_FFPROBE_PATH/);
});
