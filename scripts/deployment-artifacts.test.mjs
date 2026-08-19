import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("container pins distro media and PDF tools and exposes exact executable paths", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /ffmpeg=8\.0\.1-r1/);
  assert.match(dockerfile, /poppler-utils=25\.12\.0-r0/);
  assert.match(dockerfile, /bubblewrap=0\.11\.0-r2/);
  assert.match(dockerfile, /OPENBOARD_FFMPEG_PATH=\/usr\/bin\/ffmpeg/);
  assert.match(dockerfile, /OPENBOARD_FFPROBE_PATH=\/usr\/bin\/ffprobe/);
  assert.match(dockerfile, /OPENBOARD_PDFTOTEXT_PATH=\/usr\/bin\/pdftotext/);
  assert.match(dockerfile, /OPENBOARD_PDF_SANDBOX_PATH=\/usr\/local\/bin\/openboard-pdf-sandbox/);
  assert.doesNotMatch(dockerfile, /curl|wget.*ffmpeg/i);
  const notices = read("docs/THIRD_PARTY_NOTICES.md");
  assert.match(notices, /FFmpeg \| 8\.0\.1-r1/);
  assert.match(notices, /GPL-2\.0-or-later AND LGPL-2\.1-or-later/);
  assert.match(notices, /Poppler utilities \| 25\.12\.0-r0/);
  assert.match(notices, /Bubblewrap \| 0\.11\.0-r2/);
  const sandbox = read("docker/pdf-sandbox.sh");
  assert.match(sandbox, /--unshare-user/);
  assert.match(sandbox, /--unshare-cgroup-try/);
  assert.match(sandbox, /--clearenv/);
  assert.match(sandbox, /--ro-bind \/usr \/usr/);
  assert.match(sandbox, /--ro-bind-try \/lib \/lib/);
  assert.match(sandbox, /\/usr\/bin\/true/);
  assert.doesNotMatch(sandbox, /--unshare-all/);
  assert.doesNotMatch(sandbox, /--ro-bind \/bin \/bin/);
});

test("compose forwards media controls and bounds temporary storage", () => {
  const compose = read("compose.yaml");
  assert.match(compose, /OPENBOARD_FFMPEG_PATH:/);
  assert.match(compose, /OPENBOARD_FFPROBE_PATH:/);
  assert.match(compose, /OPENBOARD_PDFTOTEXT_PATH:/);
  assert.match(compose, /\/tmp:size=512m/);
  assert.match(compose, /mem_limit: 2g/);
  assert.match(compose, /pids_limit: 256/);
  const ciCompose = read("compose.ci.yaml");
  assert.match(ciCompose, /apparmor:unconfined/);
  assert.match(ciCompose, /seccomp:unconfined/);
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
  assert.match(workflow, /OPENBOARD_PDFTOTEXT_PATH/);
  assert.match(workflow, /apk list --installed ffmpeg/);
  assert.match(workflow, /apk list --installed poppler-utils/);
  assert.match(workflow, /"mp4Export":\[\[:space:\]\]\*true/);
  assert.match(workflow, /"pdfImport":\[\[:space:\]\]\*true/);
  assert.match(workflow, /cat film-capabilities\.json/);
  assert.match(workflow, /apparmor_restrict_unprivileged_userns/);
  assert.match(workflow, /compose\.ci\.yaml/);
  assert.doesNotMatch(workflow, /apk info -v ffmpeg/);
});
