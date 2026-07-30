export type WebStorageMode = "local" | "server";

/**
 * Production builds are expected to persist through the Go API into PostgreSQL.
 * Local IndexedDB remains an explicit offline build or the default dev-server
 * behavior, but a missing production flag must never look like an empty account.
 */
export function resolveWebStorageMode(
  command: string,
  configured: string | undefined,
): WebStorageMode {
  const value = configured?.trim();
  if (value === "server" || value === "local") return value;
  if (value) {
    throw new Error(`VITE_OPENBOARD_STORAGE must be "server" or "local", received "${value}"`);
  }
  return command === "build" ? "server" : "local";
}
