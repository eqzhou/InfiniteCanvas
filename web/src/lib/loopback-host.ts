/**
 * Loopback host detection shared by every URL validator that relaxes the HTTPS
 * requirement for local endpoints.
 *
 * `new URL("http://[::1]:11434/v1").hostname` is `"[::1]"` — brackets included —
 * so a bare `hostname === "::1"` comparison never matches a real IPv6 loopback
 * URL. Normalizing here keeps that trap in one place.
 */

const IPV6_GROUP_COUNT = 8;
const IPV4_LOOPBACK_FIRST_OCTET = 127;

/** Strip the URL brackets and any IPv6 zone id, then lowercase. */
function normalizeHostname(rawHostname: string): string {
  return rawHostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "");
}

function isIPv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false;
  return Number(octets[0]) === IPV4_LOOPBACK_FIRST_OCTET;
}

/** Expand a possibly compressed IPv6 literal into exactly 8 groups, or null when malformed. */
function expandIPv6(hostname: string): string[] | null {
  if (!hostname.includes(":")) return null;
  const halves = hostname.split("::");
  if (halves.length > 2) return null;

  const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = IPV6_GROUP_COUNT - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }

  if (groups.length !== IPV6_GROUP_COUNT) return null;
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups;
}

function isIPv6Loopback(hostname: string): boolean {
  const groups = expandIPv6(hostname);
  if (!groups) return false;
  return groups.every((group, index) =>
    Number.parseInt(group, 16) === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0),
  );
}

/**
 * True when the hostname points at this machine's loopback interface.
 * Accepts hostnames straight from `URL.hostname` (bracketed IPv6 included).
 */
export function isLoopbackHostname(rawHostname: string): boolean {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname) return false;
  if (hostname === "localhost") return true;
  if (isIPv4Loopback(hostname)) return true;
  return isIPv6Loopback(hostname);
}

/** True when the URL targets the loopback interface. Never throws on malformed input. */
export function isLoopbackUrl(url: URL | string): boolean {
  if (typeof url !== "string") return isLoopbackHostname(url.hostname);
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}
