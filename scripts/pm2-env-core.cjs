/**
 * Environment resolution for the pm2 deployment.
 *
 * `.env` is the source of truth for a deployment, so it takes precedence over
 * whatever happens to be exported in the shell that runs `pm2 start`. The
 * inverted order bit us once already: starting pm2 from a terminal that had
 * run the E2E suite picked up `OPENBOARD_TOKEN=e2e-token` — a token hardcoded
 * in `web/playwright.config.ts` and therefore public — and `pm2 save` froze it
 * into the dump, so every later restart kept using it.
 *
 * The shell is still useful for keys `.env` does not define, so it fills gaps
 * rather than being ignored outright.
 */
const path = require("node:path");

/** Values this config owns; they describe the build, not the deployment. */
const PROCESS_OWNED = Object.freeze({
  OPENBOARD_WEB_OUT_DIR: "dist-local",
  FORCE_COLOR: "0",
});

/** Applied only when neither `.env` nor the shell defines the key. */
const FALLBACKS = Object.freeze({
  OPENBOARD_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  OPENBOARD_ADDR: "127.0.0.1:8790",
  OPENBOARD_API_TARGET: "http://127.0.0.1:8790",
  OPENBOARD_AUTH_MODE: "optional",
});

/** Required keys that are absent (or blank) in both sources. */
function missingRequiredKeys(fileEnv, processEnv, required) {
  return required.filter((key) => !fileEnv[key] && !processEnv[key]);
}

/**
 * Builds the environment handed to every pm2 app. Neither input is mutated.
 * Precedence, highest first: process-owned constants, `.env`, the inherited
 * shell environment, then built-in fallbacks.
 */
function resolveDeploymentEnv(fileEnv, processEnv, { root }) {
  // Only OPENBOARD_* is inherited; the rest of the shell is not deployment
  // configuration and must not leak into the app environment.
  const inherited = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (key.startsWith("OPENBOARD_") && value) inherited[key] = value;
  }

  const resolved = { ...inherited, ...fileEnv };
  const fallbacks = { ...FALLBACKS, OPENBOARD_DATA: path.join(root, "server/data") };
  for (const [key, value] of Object.entries(fallbacks)) {
    if (!resolved[key]) resolved[key] = value;
  }
  return { ...resolved, ...PROCESS_OWNED };
}

module.exports = { FALLBACKS, PROCESS_OWNED, missingRequiredKeys, resolveDeploymentEnv };
