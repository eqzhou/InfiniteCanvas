export function normalizeExternalHttpsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("External URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("External URL must use HTTPS");
  if (url.username || url.password) throw new Error("External URL must not include credentials");
  if (url.hash) throw new Error("External URL must not include a fragment");
  if (isPrivateHost(url.hostname)) throw new Error("External URL must not target a private host");
  return url.toString();
}

function isPrivateHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true;
  }
  const octets = hostname.split(".").map(Number);
  if (octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  if (hostname.includes(":")) {
    return hostname === "::" || hostname === "::1" ||
      hostname.startsWith("fc") || hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname);
  }
  return false;
}
