/**
 * SSRF guard for outbound fetches: URLs handed to fetch helpers are validated
 * against a private-network blocklist before any request leaves the process —
 * IPv4 private/loopback/link-local/CGNAT/benchmarking/multicast, and the
 * IPv6 cases (v4-mapped and legacy embedded IPv4, loopback, link-local
 * fe80::/10, ULA fc00::/7, multicast ff00::/8, NAT64 64:ff9b::/96, 6to4
 * 2002::/16 — the embedded IPv4 decides for the tunnel prefixes). Teredo is
 * not covered here (neither was the source system); embedded credentials,
 * single-label hosts, and .localhost/.local suffixes are rejected. Plain
 * http is upgraded to https and the caller is told so it can surface the
 * upgrade. Error wording is original; the check set follows the documented
 * command-code fetch guard.
 */

export const MAX_FETCH_URL_LENGTH = 2_048;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
]);

export function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return true;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return true;
    const value = Number.parseInt(part, 10);
    if (value > 255) return true;
    octets.push(value);
  }
  const [a, b] = octets as [number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 test-net
  if (a === 198 && b === 51) return true; // test-net-2
  if (a === 203 && b === 0) return true; // test-net-3
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6ToGroups(address: string): number[] | undefined {
  let text = address;
  const doubleColon = text.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon !== -1) {
    if (text.indexOf("::", doubleColon + 1) !== -1) return undefined;
    head = doubleColon === 0 ? [] : text.slice(0, doubleColon).split(":");
    tail = doubleColon === text.length - 2 ? [] : text.slice(doubleColon + 2).split(":");
  } else {
    head = text.split(":");
    tail = [];
  }
  // Trailing IPv4-mapped form: ::ffff:192.168.0.1
  const lastHead = head.at(-1) ?? "";
  const lastTail = tail.at(-1) ?? "";
  const dotted = lastHead.includes(".") ? lastHead : lastTail.includes(".") ? lastTail : undefined;
  if (dotted !== undefined) {
    const dottedParts = dotted.split(".");
    if (dottedParts.length !== 4) return undefined;
    const values = dottedParts.map((part) => Number.parseInt(part, 10));
    if (values.some((value) => Number.isNaN(value) || value > 255)) return undefined;
    const mapped = [(values[0]! << 8) | values[1]!, (values[2]! << 8) | values[3]!];
    if (lastHead.includes(".")) {
      head = [...head.slice(0, -1), ...mapped.map((group) => group.toString(16))];
    } else {
      tail = [...tail.slice(0, -1), ...mapped.map((group) => group.toString(16))];
    }
  }
  const groups = [...head, ...tail].map((part) => Number.parseInt(part, 16));
  if (groups.some((group) => Number.isNaN(group) || group > 0xffff)) return undefined;
  if (doubleColon !== -1) {
    const missing = 8 - groups.length;
    if (missing < 0) return undefined;
    groups.splice(head.length, 0, ...new Array<number>(missing).fill(0));
  }
  return groups.length === 8 ? groups : undefined;
}

function embeddedIpv4Blocked(g6: number, g7: number): boolean {
  return isBlockedIPv4(`${(g6 >>> 8) & 0xff}.${g6 & 0xff}.${(g7 >>> 8) & 0xff}.${g7 & 0xff}`);
}

export function isBlockedIPv6(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, "").toLowerCase();
  const groups = ipv6ToGroups(text);
  if (!groups) {
    // Unparseable: fall back to well-known prefixes rather than allowing.
    return text.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(text);
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0 && g6 === 0) {
    if (g7 <= 1) return true; // :: unspecified, ::1 loopback
    return embeddedIpv4Blocked(0, g7); // ::w.x.y.z legacy IPv4-compatible
  }
  if (zeroPrefix && g5 === 0xffff) {
    return embeddedIpv4Blocked(g6, g7); // ::ffff:a.b.c.d IPv4-mapped
  }
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) {
    return embeddedIpv4Blocked(g6, g7); // NAT64 64:ff9b::/96 — judge the embedded IPv4
  }
  if (g0 === 0x2002) return embeddedIpv4Blocked(g1, g2); // 6to4 2002::/16 — judge the embedded IPv4
  return false;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(name)) return true;
  if (name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) return true;
  if (name.startsWith("[") || name.includes(":")) return isBlockedIPv6(name);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return isBlockedIPv4(name);
  // Odd numeric forms (octal/hex/short IPv4) — reject rather than guess.
  if (/^0[xX][0-9a-fA-F]+$/.test(name) || /^[0-9]+$/.test(name)) return true;
  return false;
}

export type FetchUrlGuardResult =
  | { ok: true; url: string; upgraded: boolean }
  | { ok: false; error: string };

/**
 * Validate (and normalize) one outbound URL. Applies, in order: length cap,
 * strict parse, protocol allowlist, embedded-credential rejection, private
 * host blocklist, public-hostname shape, then http→https upgrade.
 */
export function guardFetchUrl(rawUrl: string, maxLength = MAX_FETCH_URL_LENGTH): FetchUrlGuardResult {
  if (rawUrl.length > maxLength) {
    return { ok: false, error: `URL is too long (${rawUrl.length} chars; max ${maxLength}).` };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: `"${rawUrl.slice(0, 200)}" is not a valid URL. Provide a fully formed URL like https://example.com/page.` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported protocol "${parsed.protocol}" — only http:// and https:// URLs can be fetched.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "URLs with embedded credentials (user:pass@host) are not allowed." };
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    return { ok: false, error: `"${parsed.hostname}" resolves to a private, loopback, or link-local address and cannot be fetched.` };
  }
  if (!parsed.hostname.includes(".") && !parsed.hostname.includes(":")) {
    return { ok: false, error: `"${parsed.hostname}" is not a public hostname. Use a fully qualified domain like https://example.com.` };
  }
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
    return { ok: true, url: parsed.toString(), upgraded: true };
  }
  return { ok: true, url: parsed.toString(), upgraded: false };
}
