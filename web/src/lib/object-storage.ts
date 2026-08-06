import type { ObjectStorageConfig } from "@/types/board";
import { isLoopbackHostname } from "@/lib/loopback-host";

const MAX_FIELD = 8 * 1024;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function createDefaultObjectStorage(): ObjectStorageConfig {
  return {
    enabled: false,
    endpoint: "",
    bucket: "",
    region: "auto",
    prefix: "openboard",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    allowInsecureLoopback: false,
  };
}

function clip(value: unknown, max = MAX_FIELD): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Normalize persisted non-secret object storage settings. Credentials may be empty. */
export function normalizeObjectStorage(raw: unknown): ObjectStorageConfig {
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const enabled = input.enabled === true;
  const endpoint = clip(input.endpoint);
  const bucket = clip(input.bucket, 63).toLowerCase();
  const region = clip(input.region, 64) || "auto";
  let prefix = clip(input.prefix, 256).replace(/^\/+|\/+$/g, "") || "openboard";
  const accessKeyId = clip(input.accessKeyId, 256);
  const secretAccessKey = typeof input.secretAccessKey === "string"
    ? input.secretAccessKey.slice(0, 64 * 1024)
    : "";
  const sessionToken = typeof input.sessionToken === "string"
    ? input.sessionToken.slice(0, 64 * 1024)
    : "";
  const allowInsecureLoopback = input.allowInsecureLoopback === true;

  // Drop unsafe prefix segments without throwing during load.
  const segments = prefix.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || !PREFIX_SEGMENT.test(segment))) {
    prefix = "openboard";
  } else {
    prefix = segments.join("/");
  }

  return {
    enabled,
    endpoint,
    bucket,
    region,
    prefix,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    allowInsecureLoopback,
  };
}

/** Validate a fully credentialed object storage config before server use. */
export function validateObjectStorageConfig(config: ObjectStorageConfig): string | null {
  if (!config.enabled) return null;
  if (!config.endpoint) return "对象存储 Endpoint 不能为空";
  try {
    const url = new URL(config.endpoint);
    if (url.username || url.password || url.search || url.hash) {
      return "对象存储 Endpoint 不能包含凭据、查询参数或片段";
    }
    const isLoopback = isLoopbackHostname(url.hostname);
    if (url.protocol === "http:") {
      if (!config.allowInsecureLoopback || !isLoopback) {
        return "对象存储必须使用 HTTPS（仅允许 loopback HTTP）";
      }
    } else if (url.protocol !== "https:") {
      return "对象存储 Endpoint 协议无效";
    }
  } catch {
    return "对象存储 Endpoint 无效";
  }
  if (!BUCKET_PATTERN.test(config.bucket)) return "对象存储 Bucket 名称无效";
  if (!config.region) return "对象存储 Region 不能为空";
  if (!config.accessKeyId) return "对象存储 Access Key 不能为空";
  if (!config.secretAccessKey) return "对象存储 Secret Key 不能为空";
  return null;
}

export function stripObjectStorageSecrets(config: ObjectStorageConfig): ObjectStorageConfig {
  return {
    ...config,
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  };
}
