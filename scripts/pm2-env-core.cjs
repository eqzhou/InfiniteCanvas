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

const DEPLOYMENT_ENV_KEYS = Object.freeze([
  "OPENBOARD_ADDR",
  "OPENBOARD_AGENT_ACCOUNT_EXECUTION",
  "OPENBOARD_AGENT_WORKSPACE_ROOTS",
  "OPENBOARD_API_TARGET",
  "OPENBOARD_AUTH_MODE",
  "OPENBOARD_BLOB_BACKEND",
  "OPENBOARD_CLAUDE_PERMISSION_MODE",
  "OPENBOARD_DATA",
  "OPENBOARD_DATABASE_URL",
  "OPENBOARD_DEBUG",
  "OPENBOARD_FFMPEG_PATH",
  "OPENBOARD_FFPROBE_PATH",
  "OPENBOARD_FILM_IMPORT_MAX_BYTES",
  "OPENBOARD_FILM_MODE",
  "OPENBOARD_FILM_RENDER_TIMEOUT_SECONDS",
  "OPENBOARD_LINUXDO_CLIENT_ID",
  "OPENBOARD_LINUXDO_CLIENT_SECRET",
  "OPENBOARD_LINUXDO_REDIRECT_URL",
  "OPENBOARD_MASTER_KEY",
  "OPENBOARD_ORIGINS",
  "OPENBOARD_PROVIDER_PROXY_URL",
  "OPENBOARD_PUBLIC_BASE_URL",
  "OPENBOARD_REDIS_URL",
  "OPENBOARD_S3_ACCESS_KEY_ID",
  "OPENBOARD_S3_ALLOW_INSECURE_LOOPBACK",
  "OPENBOARD_S3_BUCKET",
  "OPENBOARD_S3_ENDPOINT",
  "OPENBOARD_S3_PREFIX",
  "OPENBOARD_S3_REGION",
  "OPENBOARD_S3_SECRET_ACCESS_KEY",
  "OPENBOARD_S3_SESSION_TOKEN",
  "OPENBOARD_TOKEN",
]);

/** Values this config owns; they describe the build, not the deployment. */
const PROCESS_OWNED = Object.freeze({
  OPENBOARD_WEB_OUT_DIR: "dist-local",
  FORCE_COLOR: "0",
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
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
function resolveDeploymentEnv(fileEnv, processEnv, { root, overrides = {} }) {
  // Only explicitly supported deployment keys are inherited. This keeps host
  // package-manager, loader, proxy and Compose-only secrets out of PM2.
  const inherited = {};
  const fromFile = {};
  for (const key of DEPLOYMENT_ENV_KEYS) {
    if (processEnv[key]) inherited[key] = processEnv[key];
    if (fileEnv[key]) fromFile[key] = fileEnv[key];
  }

  const resolved = { ...inherited, ...fromFile };
  const fallbacks = { ...FALLBACKS, OPENBOARD_DATA: path.join(root, "server/data") };
  for (const [key, value] of Object.entries(fallbacks)) {
    if (!resolved[key]) resolved[key] = value;
  }
  return { ...resolved, ...overrides, ...PROCESS_OWNED };
}

module.exports = { DEPLOYMENT_ENV_KEYS, FALLBACKS, PROCESS_OWNED, missingRequiredKeys, resolveDeploymentEnv };
