import assert from "node:assert/strict";
import test from "node:test";
import core from "./pm2-env-core.cjs";

const { missingRequiredKeys, resolveDeploymentEnv } = core;
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

test("unrelated .env entries are still passed through", () => {
  const resolved = resolveDeploymentEnv(
    { OPENBOARD_TOKEN: "t", OPENBOARD_MASTER_KEY: "k", OPENBOARD_POSTGRES_PASSWORD: "p" },
    {},
    { root },
  );
  assert.equal(resolved.OPENBOARD_MASTER_KEY, "k");
  assert.equal(resolved.OPENBOARD_POSTGRES_PASSWORD, "p");
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
