/**
 * PM2 process file for OpenBoard local production.
 *
 * Usage:
 *   bun run build:local && (cd server && go build -trimpath -o ./bin/openboard-server ./cmd/server)
 *   pm2 startOrReload ecosystem.config.cjs --update-env
 *   pm2 save
 *
 * UI:  http://127.0.0.1:5173/
 * API: http://127.0.0.1:8790/api/health  (Authorization: Bearer $OPENBOARD_TOKEN)
 */
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;

function loadEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const fileEnv = loadEnvFile(path.join(root, ".env"));
const required = [
  "OPENBOARD_TOKEN",
  "OPENBOARD_DATABASE_URL",
  "OPENBOARD_REDIS_URL",
  "OPENBOARD_MASTER_KEY",
];
for (const key of required) {
  if (!fileEnv[key] && !process.env[key]) {
    throw new Error(`${key} is required in ${path.join(root, ".env")}`);
  }
}

const token = process.env.OPENBOARD_TOKEN || fileEnv.OPENBOARD_TOKEN;
const origins = process.env.OPENBOARD_ORIGINS
  || fileEnv.OPENBOARD_ORIGINS
  || "http://localhost:5173,http://127.0.0.1:5173";
const dataDir = process.env.OPENBOARD_DATA
  || fileEnv.OPENBOARD_DATA
  || path.join(root, "server/data");

const sharedEnv = {
  ...fileEnv,
  OPENBOARD_TOKEN: token,
  OPENBOARD_ORIGINS: origins,
  OPENBOARD_ADDR: process.env.OPENBOARD_ADDR || "127.0.0.1:8790",
  OPENBOARD_DATA: dataDir,
  OPENBOARD_API_TARGET: process.env.OPENBOARD_API_TARGET || "http://127.0.0.1:8790",
  OPENBOARD_WEB_OUT_DIR: "dist-local",
  FORCE_COLOR: "0",
};

module.exports = {
  apps: [
    {
      name: "openboard-api",
      cwd: path.join(root, "server"),
      script: path.join(root, "server/bin/openboard-server"),
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      time: true,
      env: sharedEnv,
    },
    {
      name: "openboard-web",
      cwd: path.join(root, "web"),
      script: path.join(root, "web/node_modules/.bin/vite"),
      args: "preview --host 127.0.0.1 --port 5173 --strictPort --outDir dist-local",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      time: true,
      env: sharedEnv,
    },
  ],
};
