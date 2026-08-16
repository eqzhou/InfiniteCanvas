import { defineConfig, devices } from "@playwright/test";
import { resolveE2EEnvironment, type E2EMode } from "./e2e/environment";

const { mode, production, formal, webPort, agentPort, origin } = resolveE2EEnvironment();
const canvasSuite = process.env.OPENBOARD_E2E_CANVAS === "1";
const chromiumExecutable = process.env.OPENBOARD_CHROMIUM_EXECUTABLE;
const dataDir = production
  ? "$(mktemp -d \"${TMPDIR:-/tmp}/openboard-e2e-prod.XXXXXX\")"
  : "../web/node_modules/.cache/openboard-agent-e2e";

type AgentServerCommandOptions = Readonly<{
  mode: E2EMode;
  agentPort: number;
  origin: string;
  dataDir: string;
}>;

const loadLocalEnv = "if [ -f ../.env ]; then set -a; . ../.env; set +a; fi;";

export function createAgentServerCommand({
  mode,
  agentPort,
  origin,
  dataDir,
}: AgentServerCommandOptions): string {
  if (mode === "production") {
    return `data_dir=${dataDir}; trap 'rm -rf "$data_dir"' EXIT; ${loadLocalEnv} cd ../server && GOSUMDB=sum.golang.org OPENBOARD_ADDR=127.0.0.1:${agentPort} OPENBOARD_ORIGINS=${origin} OPENBOARD_TOKEN=e2e-token OPENBOARD_AUTH_MODE=off OPENBOARD_E2E_TENANT_TOKEN=e2e-tenant-token OPENBOARD_DATA="$data_dir" go run ./cmd/server`;
  }
  if (mode === "formal") {
    return `../scripts/run-formal-e2e-server.sh ${agentPort} ${origin}`;
  }
  return `${loadLocalEnv} cd ../server && GOSUMDB=sum.golang.org OPENBOARD_ADDR=127.0.0.1:${agentPort} OPENBOARD_ORIGINS=${origin} OPENBOARD_TOKEN=e2e-token OPENBOARD_AUTH_MODE=off OPENBOARD_E2E_TENANT_TOKEN=e2e-tenant-token OPENBOARD_DATA=../web/node_modules/.cache/openboard-agent-e2e go run ./cmd/server`;
}

type WebServerCommandOptions = Readonly<{
  mode: E2EMode;
  agentPort: number;
  webPort: number;
}>;

export function createWebServerCommand({
  mode,
  agentPort,
  webPort,
}: WebServerCommandOptions): string {
  if (mode === "production") {
    return `OPENBOARD_API_TARGET=http://127.0.0.1:${agentPort} OPENBOARD_TOKEN=e2e-token bun run build && OPENBOARD_API_TARGET=http://127.0.0.1:${agentPort} OPENBOARD_TOKEN=e2e-token bun run preview --host 127.0.0.1 --port ${webPort}`;
  }
  if (mode === "formal") {
    return `bun run build && OPENBOARD_API_TARGET=http://127.0.0.1:${agentPort} OPENBOARD_TOKEN=e2e-token bun run preview --host 127.0.0.1 --port ${webPort}`;
  }
  return `OPENBOARD_API_TARGET=http://127.0.0.1:${agentPort} OPENBOARD_TOKEN=e2e-token bun run dev --host 127.0.0.1 --port ${webPort} --strictPort`;
}

export default defineConfig({
	timeout: formal ? 120_000 : 60_000,
  testDir: "./e2e",
  testMatch: canvasSuite ? "canvas.spec.ts" : formal ? "formal-storage.spec.ts" : ["canvas.spec.ts", "film.spec.ts"],
  outputDir: "./node_modules/.cache/playwright-test-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
	retries: formal ? 0 : process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(formal ? { extraHTTPHeaders: {
      "X-OpenBoard-E2E-Tenant": "e2e-0123456789abcdef01234567",
      "X-OpenBoard-E2E-Token": "e2e-tenant-token-0123456789abcdef",
    } } : {}),
  },
  projects: (formal ? [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
		locale: "zh-CN",
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
  ] : [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
  ]),
  webServer: [
    {
      command: createWebServerCommand({ mode, agentPort, webPort }),
      url: origin,
		reuseExistingServer: !formal && !process.env.CI,
      timeout: 120_000,
    },
    {
      command: createAgentServerCommand({ mode, agentPort, origin, dataDir }),
      url: `http://127.0.0.1:${agentPort}/api/health`,
		reuseExistingServer: !formal && !process.env.CI,
      timeout: 120_000,
    },
  ],
});
