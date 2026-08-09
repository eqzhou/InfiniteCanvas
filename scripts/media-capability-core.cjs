const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MEDIA_ENV_KEYS = Object.freeze([
  "OPENBOARD_FFMPEG_PATH",
  "OPENBOARD_FFPROBE_PATH",
]);

function findCommand(name, searchPath = process.env.PATH || "") {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH; absence is a supported degraded mode.
    }
  }
  return "";
}

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function probeVersion(candidate) {
  const result = spawnSync(candidate, ["-hide_banner", "-version"], {
    stdio: "ignore",
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

function defaultDependencies(processEnv) {
  return {
    findCommand: (name) => findCommand(name, processEnv.PATH || process.env.PATH || ""),
    realpath: (candidate) => fs.realpathSync(candidate),
    isExecutableFile,
    probeVersion,
  };
}

function configuredValue(fileEnv, processEnv, key) {
  if (typeof fileEnv[key] === "string" && fileEnv[key].trim()) {
    return { explicit: true, value: fileEnv[key].trim() };
  }
  if (typeof processEnv[key] === "string" && processEnv[key].trim()) {
    return { explicit: true, value: processEnv[key].trim() };
  }
  return { explicit: false, value: "" };
}

function resolveTool(name, key, fileEnv, processEnv, dependencies) {
  const configured = configuredValue(fileEnv, processEnv, key);
  const candidate = configured.value || dependencies.findCommand(name);
  if (!candidate) return { error: `${name} was not found` };
  if (!path.isAbsolute(candidate) || candidate.includes("\0") || /[\r\n]/.test(candidate)) {
    return { error: `${name} configured path must be a clean absolute path` };
  }

  let resolved;
  try {
    resolved = dependencies.realpath(candidate);
  } catch {
    return { error: `${name} executable is unavailable` };
  }
  if (!path.isAbsolute(resolved) || !dependencies.isExecutableFile(resolved)) {
    return { error: `${name} executable is unavailable` };
  }
  if (!dependencies.probeVersion(resolved)) {
    return { error: `${name} capability probe failed` };
  }
  return { path: resolved };
}

function diagnoseMediaCapabilities(fileEnv = {}, processEnv = {}, dependencies) {
  const runtime = dependencies || defaultDependencies(processEnv);
  const ffmpeg = resolveTool("ffmpeg", MEDIA_ENV_KEYS[0], fileEnv, processEnv, runtime);
  if (ffmpeg.error) {
    return {
      available: false,
      diagnostic: `MP4 export disabled: ${ffmpeg.error}; all other OpenBoard services remain available`,
      env: { OPENBOARD_FFMPEG_PATH: "", OPENBOARD_FFPROBE_PATH: "" },
    };
  }
  const ffprobe = resolveTool("ffprobe", MEDIA_ENV_KEYS[1], fileEnv, processEnv, runtime);
  if (ffprobe.error) {
    return {
      available: false,
      diagnostic: `MP4 export disabled: ${ffprobe.error}; all other OpenBoard services remain available`,
      env: { OPENBOARD_FFMPEG_PATH: "", OPENBOARD_FFPROBE_PATH: "" },
    };
  }
  return {
    available: true,
    diagnostic: `MP4 export enabled: ffmpeg=${ffmpeg.path}; ffprobe=${ffprobe.path}`,
    env: {
      OPENBOARD_FFMPEG_PATH: ffmpeg.path,
      OPENBOARD_FFPROBE_PATH: ffprobe.path,
    },
  };
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function shellExports(env) {
  return MEDIA_ENV_KEYS.map((key) => `export ${key}=${quoteShell(env[key] || "")}`).join("\n");
}

module.exports = {
  MEDIA_ENV_KEYS,
  diagnoseMediaCapabilities,
  findCommand,
  isExecutableFile,
  probeVersion,
  shellExports,
};
