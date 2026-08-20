import { describe, expect, test } from "bun:test";

import { resolveE2EEnvironment } from "../e2e/environment";
import { createAgentServerCommand, createWebServerCommand } from "../playwright.config";

async function loadPlaywrightConfig(ci: boolean) {
  const previousCi = process.env.CI;
  const previousFormal = process.env.OPENBOARD_E2E_FORMAL;

  if (ci) {
    process.env.CI = "1";
  } else {
    delete process.env.CI;
  }
  delete process.env.OPENBOARD_E2E_FORMAL;

  try {
    return (await import(`../playwright.config.ts?ci=${ci ? "1" : "0"}`)).default;
  } finally {
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    if (previousFormal === undefined) {
      delete process.env.OPENBOARD_E2E_FORMAL;
    } else {
      process.env.OPENBOARD_E2E_FORMAL = previousFormal;
    }
  }
}

describe("Playwright retry limits", () => {
  test("retries one time and caps failures in CI", async () => {
    const config = await loadPlaywrightConfig(true);

    expect(config.retries).toBe(1);
    expect(config.maxFailures).toBe(5);
  });

  test("does not cap failures locally", async () => {
    const config = await loadPlaywrightConfig(false);

    expect(config.retries).toBe(0);
    expect(config.maxFailures).toBe(0);
  });
});

describe("Playwright E2E environment", () => {
  test("rejects formal and production mode being enabled together", () => {
    expect(() => resolveE2EEnvironment({
      OPENBOARD_E2E_FORMAL: "1",
      OPENBOARD_E2E_PRODUCTION: "1",
    })).toThrow("cannot both be enabled");
  });

  test.each(["", "0", "-1", "65536", "1e3", " 5183 ", "NaN", "Infinity"])(
    "rejects an invalid web port (%s)",
    (value) => {
      expect(() => resolveE2EEnvironment({ OPENBOARD_E2E_WEB_PORT: value })).toThrow(
        "OPENBOARD_E2E_WEB_PORT",
      );
    },
  );

  test("normalizes one shared set of ports and mode flags", () => {
    expect(resolveE2EEnvironment({
      OPENBOARD_E2E_PRODUCTION: "1",
      OPENBOARD_E2E_WEB_PORT: "5184",
      OPENBOARD_E2E_AGENT_PORT: "8892",
    })).toEqual({
      mode: "production",
      production: true,
      formal: false,
      webPort: 5184,
      agentPort: 8892,
      origin: "http://127.0.0.1:5184",
    });
  });
});

describe("Playwright agent server command", () => {
  test.each([false, true])("disables account auth for canvas E2E (production=%s)", (production) => {
    const command = createAgentServerCommand({
      mode: production ? "production" : "development",
      agentPort: production ? 8792 : 8791,
      origin: production ? "http://127.0.0.1:5174" : "http://127.0.0.1:5173",
      dataDir: "/tmp/openboard-e2e-test",
    });

    expect(command).toContain("OPENBOARD_AUTH_MODE=off");
    expect(command).toContain("OPENBOARD_E2E_TENANT_TOKEN=e2e-tenant-token");
  });

  test("loads local database credentials when the repository has a .env file", () => {
    const command = createAgentServerCommand({
      mode: "development",
      agentPort: 8891,
      origin: "http://127.0.0.1:5173",
      dataDir: "/tmp/openboard-e2e-test",
    });

    expect(command).toContain("if [ -f ../.env ]; then set -a; . ../.env; set +a; fi;");
  });
});

describe("Playwright web server command", () => {
  test("honors the isolated development port", () => {
    const command = createWebServerCommand({
      mode: "development",
      agentPort: 8891,
      webPort: 5183,
    });

    expect(command).toContain("--port 5183");
    expect(command).toContain("--strictPort");
  });
});
