export type ExternalUrlPolicy = {
  /** Allow http only for private/loopback hosts (local personal deployments). */
  allowHttpOnPrivateHosts?: boolean;
  /** Allow loopback and private LAN hosts. */
  allowPrivateHosts?: boolean;
};

export function normalizeExternalHttpsUrl(raw: string): string {
  return normalizeExternalUrl(raw, {
    allowHttpOnPrivateHosts: false,
    allowPrivateHosts: false,
  });
}

/** Prompt-source URLs for local personal use: HTTPS public hosts, or local http(s) hosts. */
export function normalizeExternalSourceUrl(raw: string): string {
  const normalized = normalizeExternalUrl(raw, {
    allowHttpOnPrivateHosts: true,
    allowPrivateHosts: true,
  });
  const url = new URL(normalized);
  for (const key of url.searchParams.keys()) {
    if (/(^|[-_.])(token|secret|api[-_.]?key|key|sig|signature|credential|authorization|auth)([-_.]|$)/i.test(key)) {
      throw new Error("External URL must not include credentials in query parameters");
    }
  }
  return normalized;
}

function normalizeExternalUrl(raw: string, policy: ExternalUrlPolicy): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("External URL is invalid");
  }

  const privateHost = isPrivateHost(url.hostname);
  if (url.protocol === "https:") {
    // ok
  } else if (url.protocol === "http:") {
    if (!policy.allowHttpOnPrivateHosts || !privateHost) {
      throw new Error("External URL must use HTTPS");
    }
  } else {
    throw new Error("External URL must use HTTPS");
  }

  if (url.username || url.password) throw new Error("External URL must not include credentials");
  if (url.hash) throw new Error("External URL must not include a fragment");
  if (privateHost && !policy.allowPrivateHosts) {
    throw new Error("External URL must not target a private host");
  }
  return url.toString();
}

function isPrivateHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true;
  }
  const octets = hostname.split(".").map(Number);
  if (isPrivateIPv4(octets)) return true;
  if (hostname.includes(":")) {
    const embedded = hostname.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (embedded) {
      const high = Number.parseInt(embedded[1], 16);
      const low = Number.parseInt(embedded[2], 16);
      if (isPrivateIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff])) return true;
    }
    return hostname === "::" || hostname === "::1" ||
      hostname.startsWith("fc") || hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname);
  }
  return false;
}

function isPrivateIPv4(octets: number[]): boolean {
  if (octets.length !== 4 || !octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}
