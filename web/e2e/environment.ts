export type E2EMode = "development" | "production" | "formal";

export type E2EEnvironment = Readonly<{
  mode: E2EMode;
  production: boolean;
  formal: boolean;
  webPort: number;
  agentPort: number;
  origin: string;
}>;

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function resolveE2EEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): E2EEnvironment {
  const production = env.OPENBOARD_E2E_PRODUCTION === "1";
  const formal = env.OPENBOARD_E2E_FORMAL === "1";
  if (production && formal) {
    throw new Error("OPENBOARD_E2E_PRODUCTION and OPENBOARD_E2E_FORMAL cannot both be enabled");
  }
  const mode: E2EMode = formal ? "formal" : production ? "production" : "development";
  const webPort = parsePort(
    env.OPENBOARD_E2E_WEB_PORT,
    formal ? 5175 : production ? 5174 : 5173,
    "OPENBOARD_E2E_WEB_PORT",
  );
  const agentPort = parsePort(
    env.OPENBOARD_E2E_AGENT_PORT,
    formal ? 8793 : production ? 8792 : 8791,
    "OPENBOARD_E2E_AGENT_PORT",
  );
  return {
    mode,
    production,
    formal,
    webPort,
    agentPort,
    origin: `http://127.0.0.1:${webPort}`,
  };
}
