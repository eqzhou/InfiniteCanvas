import assert from "node:assert/strict";
import test from "node:test";
import core from "./pm2-env-core.cjs";

const {
  DEPLOYMENT_ENV_KEYS,
  hasUnsafeSecretFilePermissions,
  missingRequiredKeys,
  resolveDeploymentEnv,
  resolveWebEnv,
} = core;
const root = "/srv/openboard";

test(".env wins over an inherited shell variable", () => {
  // The regression this guards: pm2 started from a shell that had exported
  // OPENBOARD_TOKEN=e2e-token (the token hardcoded in playwright.config.ts)
  // silently ran the deployment on that public test token, and `pm2 save`
  // then froze it into the dump.
  const resolved = resolveDeploymentEnv(
    { OPENBOARD_TOKEN: "real-secret", OPENBOARD_AUTH_MODE: "optional" },
    { OPENBOARD_TOKEN: "e2e-token", OPENBOARD_AUTH_MODE: "off" },
    { root },
  );
  assert.equal(resolved.OPENBOARD_TOKEN, "real-secret");
  assert.equal(resolved.OPENBOARD_AUTH_MODE, "optional");
});

test("the shell still fills in keys the .env file does not define", () => {
  // Precedence is inverted, not ignored: a key absent from .env can still be
  // supplied for a one-off run.
  const resolved = resolveDeploymentEnv(
    { OPENBOARD_TOKEN: "real-secret" },
    { OPENBOARD_ADDR: "127.0.0.1:9999" },
    { root },
  );
  assert.equal(resolved.OPENBOARD_ADDR, "127.0.0.1:9999");
});

test("built-in defaults apply only when neither source defines the key", () => {
  const resolved = resolveDeploymentEnv({ OPENBOARD_TOKEN: "t" }, {}, { root });
  assert.equal(resolved.OPENBOARD_ADDR, "127.0.0.1:8790");
  assert.equal(resolved.OPENBOARD_AUTH_MODE, "optional");
  assert.equal(resolved.OPENBOARD_DATA, "/srv/openboard/server/data");
  assert.equal(resolved.OPENBOARD_API_TARGET, "http://127.0.0.1:8790");
  assert.equal(resolved.OPENBOARD_ORIGINS, "http://localhost:5173,http://127.0.0.1:5173");
});

test("a .env address is honored instead of being clobbered by the default", () => {
  // The previous code read OPENBOARD_ADDR from process.env only, so the
  // spread of .env was overwritten by the default and the file value was lost.
  const resolved = resolveDeploymentEnv(
    { OPENBOARD_TOKEN: "t", OPENBOARD_ADDR: "127.0.0.1:8791", OPENBOARD_API_TARGET: "http://127.0.0.1:8791" },
    {},
    { root },
  );
  assert.equal(resolved.OPENBOARD_ADDR, "127.0.0.1:8791");
  assert.equal(resolved.OPENBOARD_API_TARGET, "http://127.0.0.1:8791");
});

test("process-owned constants are not overridable from the shell", () => {
  // These describe how this config builds the app, not how it is deployed.
  const resolved = resolveDeploymentEnv(
    { OPENBOARD_TOKEN: "t" },
    { OPENBOARD_WEB_OUT_DIR: "dist-hijacked", FORCE_COLOR: "1" },
    { root },
  );
  assert.equal(resolved.OPENBOARD_WEB_OUT_DIR, "dist-local");
  assert.equal(resolved.FORCE_COLOR, "0");
});

test("desktop shell proxies never leak into pm2 provider traffic", () => {
  const resolved = resolveDeploymentEnv(
    { OPENBOARD_TOKEN: "t" },
    {
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:7890",
    },
    { root },
  );
  assert.equal(resolved.HTTP_PROXY, "");
  assert.equal(resolved.HTTPS_PROXY, "");
  assert.equal(resolved.ALL_PROXY, "");
});

test("an explicit OpenBoard provider proxy remains available", () => {
  const resolved = resolveDeploymentEnv(
    { OPENBOARD_TOKEN: "t", OPENBOARD_PROVIDER_PROXY_URL: "http://127.0.0.1:7899" },
    { HTTPS_PROXY: "http://127.0.0.1:7890" },
    { root },
  );
  assert.equal(resolved.OPENBOARD_PROVIDER_PROXY_URL, "http://127.0.0.1:7899");
});

test("only allowlisted deployment settings are passed through", () => {
  const resolved = resolveDeploymentEnv(
    {
      OPENBOARD_TOKEN: "t",
      OPENBOARD_MASTER_KEY: "k",
      OPENBOARD_FFMPEG_PATH: "/usr/bin/ffmpeg",
      OPENBOARD_POSTGRES_PASSWORD: "must-not-leak",
      NODE_OPTIONS: "--require /tmp/injected.cjs",
    },
    { OPENBOARD_UNKNOWN_SETTING: "must-not-leak", PATH: "/tmp/untrusted" },
    { root },
  );
  assert.equal(resolved.OPENBOARD_MASTER_KEY, "k");
  assert.equal(resolved.OPENBOARD_FFMPEG_PATH, "/usr/bin/ffmpeg");
  assert.equal(resolved.OPENBOARD_POSTGRES_PASSWORD, undefined);
  assert.equal(resolved.OPENBOARD_UNKNOWN_SETTING, undefined);
  assert.equal(resolved.NODE_OPTIONS, undefined);
  assert.equal(resolved.PATH, undefined);
});

test("the web process receives only its proxy and process-owned environment", () => {
  const deployment = resolveDeploymentEnv(
    {
      OPENBOARD_API_TARGET: "http://127.0.0.1:8790",
      OPENBOARD_TOKEN: "proxy-token",
      OPENBOARD_DATABASE_URL: "postgres://secret",
      OPENBOARD_REDIS_URL: "redis://secret",
      OPENBOARD_MASTER_KEY: "master-secret",
      OPENBOARD_S3_SECRET_ACCESS_KEY: "object-secret",
    },
    {},
    { root },
  );

  const resolved = resolveWebEnv(deployment);

  assert.equal(resolved.OPENBOARD_API_TARGET, "http://127.0.0.1:8790");
  assert.equal(resolved.OPENBOARD_TOKEN, "proxy-token");
  assert.equal(resolved.OPENBOARD_WEB_OUT_DIR, "dist-local");
  assert.equal(resolved.FORCE_COLOR, "0");
  assert.equal(resolved.OPENBOARD_DATABASE_URL, "");
  assert.equal(resolved.OPENBOARD_REDIS_URL, "");
  assert.equal(resolved.OPENBOARD_MASTER_KEY, "");
  assert.equal(resolved.OPENBOARD_S3_SECRET_ACCESS_KEY, "");
});

test("PM2 rejects group-readable or world-readable secret files on POSIX", () => {
  assert.equal(hasUnsafeSecretFilePermissions(0o100600, "darwin"), false);
  assert.equal(hasUnsafeSecretFilePermissions(0o100640, "linux"), true);
  assert.equal(hasUnsafeSecretFilePermissions(0o100644, "linux"), true);
  assert.equal(hasUnsafeSecretFilePermissions(0o100666, "linux"), true);
  assert.equal(hasUnsafeSecretFilePermissions(0o100644, "win32"), false);
});

test("the PM2 allowlist includes bounded media and PDF executables", () => {
  assert.ok(DEPLOYMENT_ENV_KEYS.includes("OPENBOARD_FFMPEG_PATH"));
  assert.ok(DEPLOYMENT_ENV_KEYS.includes("OPENBOARD_FFPROBE_PATH"));
  assert.ok(DEPLOYMENT_ENV_KEYS.includes("OPENBOARD_PDFTOTEXT_PATH"));
  assert.ok(DEPLOYMENT_ENV_KEYS.includes("OPENBOARD_PDFTOTEXT_TIMEOUT"));
  assert.ok(DEPLOYMENT_ENV_KEYS.includes("OPENBOARD_PDFTOTEXT_MAX_OUTPUT_BYTES"));
  assert.ok(DEPLOYMENT_ENV_KEYS.includes("OPENBOARD_PDF_SANDBOX_PATH"));
});

test("the PM2 allowlist carries every incremental feature gate", () => {
  for (const name of [
    "OPENBOARD_WEBDAV_MEDIA",
    "OPENBOARD_ADVANCED_VOICE",
    "OPENBOARD_LOCAL_WORKFLOWS",
    "OPENBOARD_COMFYUI_EXECUTORS",
    "OPENBOARD_STYLE_EXTRACTION",
    "OPENBOARD_FILM_STAGE_WAIVER",
  ]) {
    assert.ok(DEPLOYMENT_ENV_KEYS.includes(name), `${name} must reach the API process`);
  }
});

test("final capability overrides can clear stale inherited media paths", () => {
  const resolved = resolveDeploymentEnv(
    {},
    {
      OPENBOARD_FFMPEG_PATH: "/stale/ffmpeg",
      OPENBOARD_FFPROBE_PATH: "/stale/ffprobe",
    },
    {
      root,
      overrides: { OPENBOARD_FFMPEG_PATH: "", OPENBOARD_FFPROBE_PATH: "" },
    },
  );
  assert.equal(resolved.OPENBOARD_FFMPEG_PATH, "");
  assert.equal(resolved.OPENBOARD_FFPROBE_PATH, "");
});

test("required keys may come from either source", () => {
  const required = ["OPENBOARD_TOKEN", "OPENBOARD_DATABASE_URL", "OPENBOARD_REDIS_URL", "OPENBOARD_MASTER_KEY"];
  assert.deepEqual(missingRequiredKeys({}, {}, required), required);
  assert.deepEqual(
    missingRequiredKeys(
      { OPENBOARD_TOKEN: "t", OPENBOARD_DATABASE_URL: "d" },
      { OPENBOARD_REDIS_URL: "r", OPENBOARD_MASTER_KEY: "m" },
      required,
    ),
    [],
  );
  // A blank value is not a value.
  assert.deepEqual(missingRequiredKeys({ OPENBOARD_TOKEN: "" }, {}, ["OPENBOARD_TOKEN"]), ["OPENBOARD_TOKEN"]);
});

test("resolution never mutates its inputs", () => {
  const fileEnv = { OPENBOARD_TOKEN: "t" };
  const processEnv = { OPENBOARD_ADDR: "127.0.0.1:9999" };
  resolveDeploymentEnv(fileEnv, processEnv, { root });
  assert.deepEqual(fileEnv, { OPENBOARD_TOKEN: "t" });
  assert.deepEqual(processEnv, { OPENBOARD_ADDR: "127.0.0.1:9999" });
});
