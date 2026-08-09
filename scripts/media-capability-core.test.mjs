import assert from "node:assert/strict";
import test from "node:test";
import core from "./media-capability-core.cjs";

const { diagnoseMediaCapabilities, shellExports } = core;

function fakeDependencies({
  commands = {},
  realpaths = {},
  executablePaths = [],
  probeFailures = [],
} = {}) {
  return {
    findCommand: (name) => commands[name] ?? "",
    realpath: (path) => realpaths[path] ?? path,
    isExecutableFile: (path) => executablePaths.includes(path),
    probeVersion: (path) => !probeFailures.includes(path),
  };
}

test("resolves PATH tools to regular executable realpaths", () => {
  const result = diagnoseMediaCapabilities({}, {}, fakeDependencies({
    commands: { ffmpeg: "/opt/bin/ffmpeg", ffprobe: "/opt/bin/ffprobe" },
    realpaths: {
      "/opt/bin/ffmpeg": "/opt/cellar/ffmpeg/bin/ffmpeg",
      "/opt/bin/ffprobe": "/opt/cellar/ffmpeg/bin/ffprobe",
    },
    executablePaths: [
      "/opt/cellar/ffmpeg/bin/ffmpeg",
      "/opt/cellar/ffmpeg/bin/ffprobe",
    ],
  }));

  assert.equal(result.available, true);
  assert.deepEqual(result.env, {
    OPENBOARD_FFMPEG_PATH: "/opt/cellar/ffmpeg/bin/ffmpeg",
    OPENBOARD_FFPROBE_PATH: "/opt/cellar/ffmpeg/bin/ffprobe",
  });
});

test(".env paths outrank inherited paths and PATH discovery", () => {
  const result = diagnoseMediaCapabilities(
    {
      OPENBOARD_FFMPEG_PATH: "/deployment/ffmpeg",
      OPENBOARD_FFPROBE_PATH: "/deployment/ffprobe",
    },
    {
      OPENBOARD_FFMPEG_PATH: "/shell/ffmpeg",
      OPENBOARD_FFPROBE_PATH: "/shell/ffprobe",
    },
    fakeDependencies({
      commands: { ffmpeg: "/path/ffmpeg", ffprobe: "/path/ffprobe" },
      executablePaths: ["/deployment/ffmpeg", "/deployment/ffprobe"],
    }),
  );

  assert.equal(result.available, true);
  assert.equal(result.env.OPENBOARD_FFMPEG_PATH, "/deployment/ffmpeg");
  assert.equal(result.env.OPENBOARD_FFPROBE_PATH, "/deployment/ffprobe");
});

test("a missing or failed tool disables only MP4 by clearing both paths", () => {
  const missing = diagnoseMediaCapabilities({}, {}, fakeDependencies({
    commands: { ffmpeg: "/usr/bin/ffmpeg" },
    executablePaths: ["/usr/bin/ffmpeg"],
  }));
  assert.equal(missing.available, false);
  assert.deepEqual(missing.env, {
    OPENBOARD_FFMPEG_PATH: "",
    OPENBOARD_FFPROBE_PATH: "",
  });
  assert.match(missing.diagnostic, /MP4 export disabled/);

  const failed = diagnoseMediaCapabilities({}, {}, fakeDependencies({
    commands: { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" },
    executablePaths: ["/usr/bin/ffmpeg", "/usr/bin/ffprobe"],
    probeFailures: ["/usr/bin/ffprobe"],
  }));
  assert.equal(failed.available, false);
  assert.deepEqual(failed.env, missing.env);
  assert.match(failed.diagnostic, /ffprobe capability probe failed/);
});

test("explicit invalid paths fail closed instead of falling back to PATH", () => {
  const result = diagnoseMediaCapabilities(
    { OPENBOARD_FFMPEG_PATH: "relative/ffmpeg" },
    {},
    fakeDependencies({
      commands: { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" },
      executablePaths: ["/usr/bin/ffmpeg", "/usr/bin/ffprobe"],
    }),
  );

  assert.equal(result.available, false);
  assert.match(result.diagnostic, /absolute path/);
});

test("shell exports quote paths without permitting shell expansion", () => {
  assert.equal(
    shellExports({
      OPENBOARD_FFMPEG_PATH: "/tmp/a path/ff'mpeg$HOME",
      OPENBOARD_FFPROBE_PATH: "",
    }),
    "export OPENBOARD_FFMPEG_PATH='/tmp/a path/ff'\"'\"'mpeg$HOME'\nexport OPENBOARD_FFPROBE_PATH=''",
  );
});
