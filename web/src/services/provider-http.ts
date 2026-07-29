import type { AiEndpointConfig } from "@/types/board";
import { readBoundedProviderText } from "@/services/bounded-provider-json";

const DEFAULT_ERROR_BYTES = 64 * 1024;

export type ProviderAuth = "bearer" | "x-api-key" | "x-goog-api-key";

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

function validateProviderBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("AI provider URL is invalid");
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error("AI provider URL contains forbidden credentials, query, or fragment");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("AI provider URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  return parsed;
}

function validateProviderRequestUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("AI provider URL is invalid");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("AI provider URL contains forbidden credentials or fragment");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("AI provider URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  return parsed.toString();
}

export function joinProviderUrl(baseUrl: string, requestPath: string): string {
  const parsed = validateProviderBaseUrl(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const versionedBase = basePath.endsWith("/v1") ||
    basePath.endsWith("/v1beta") ||
    basePath.endsWith("/api/v3") ||
    basePath.endsWith("/api/plan/v3")
    ? basePath
    : `${basePath}/v1`;
  parsed.pathname = `${versionedBase}/${requestPath.replace(/^\/+/, "")}`;
  return parsed.toString();
}

function authForProvider(provider: AiEndpointConfig): ProviderAuth {
  if (provider.protocol === "gemini") return "x-goog-api-key";
  if (provider.protocol === "template" && provider.template?.auth) return provider.template.auth;
  return "bearer";
}

export async function providerFetchUrl(
  url: string,
  apiKey: string,
  auth: ProviderAuth,
  init: RequestInit = {},
  options: {
    fetcher?: typeof fetch;
    errorPrefix?: string;
    maxErrorBytes?: number;
  } = {},
): Promise<Response> {
  if (init.signal?.aborted) {
    throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const validatedUrl = validateProviderRequestUrl(url);
  const headers = new Headers(init.headers);
  if (apiKey) {
    headers.set(
      auth === "bearer" ? "Authorization" : auth,
      auth === "bearer" ? `Bearer ${apiKey}` : apiKey,
    );
  }
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await (options.fetcher ?? fetch)(validatedUrl, {
    ...init,
    headers,
    redirect: "error",
  });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new ProviderHttpError(response.status, `${options.errorPrefix ?? "AI"} redirect was rejected`);
  }
  if (!response.ok) {
    const detail = await readBoundedProviderText(
      response,
      options.maxErrorBytes ?? DEFAULT_ERROR_BYTES,
    ).catch(() => "");
    throw new ProviderHttpError(
      response.status,
      `${options.errorPrefix ?? "AI"} ${response.status}: ${detail || response.statusText}`,
    );
  }
  return response;
}

export function providerFetch(
  provider: AiEndpointConfig,
  path: string,
  init: RequestInit = {},
  options: {
    fetcher?: typeof fetch;
    errorPrefix?: string;
    maxErrorBytes?: number;
  } = {},
): Promise<Response> {
  return providerFetchUrl(
    joinProviderUrl(provider.baseUrl, path),
    provider.apiKey,
    authForProvider(provider),
    init,
    options,
  );
}
