import { defineConfig, devices } from "@playwright/test";

const production = process.env.OPENBOARD_E2E_PRODUCTION === "1";
const webPort = production ? 5174 : 5173;
const agentPort = production ? 8792 : 8791;
const origin = `http://127.0.0.1:${webPort}`;
const dataDir = production
  ? "$(mktemp -d \"${TMPDIR:-/tmp}/openboard-e2e-prod.XXXXXX\")"
  : "../web/node_modules/.cache/openboard-agent-e2e";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./node_modules/.cache/playwright-test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
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
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: [
    {
      command: production
        ? `bun run build && bun run preview --host 127.0.0.1 --port ${webPort}`
        : "bun run dev --host 127.0.0.1",
      url: origin,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: production
        ? `data_dir=${dataDir}; trap 'rm -rf "$data_dir"' EXIT; cd ../server && GOSUMDB=sum.golang.org OPENBOARD_ADDR=127.0.0.1:${agentPort} OPENBOARD_ORIGINS=${origin} OPENBOARD_TOKEN=e2e-token OPENBOARD_DATA="$data_dir" go run ./cmd/server`
        : `cd ../server && GOSUMDB=sum.golang.org OPENBOARD_ADDR=127.0.0.1:${agentPort} OPENBOARD_ORIGINS=${origin} OPENBOARD_TOKEN=e2e-token OPENBOARD_DATA=../web/node_modules/.cache/openboard-agent-e2e go run ./cmd/server`,
      url: `http://127.0.0.1:${agentPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
