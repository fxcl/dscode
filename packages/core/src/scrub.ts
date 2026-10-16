/**
 * Two-tier secret and PII scrubbing for text that leaves the process:
 *
 *   - tier 1 (secrets): home-directory paths, long hex tokens, and
 *     vendor-prefixed API keys become placeholders — safe enough for
 *     telemetry, and the default for /export tool-argument rendering;
 *   - tier 2 (network facts, for error text): URLs, IP addresses, and
 *     errno-plus-hostname pairs additionally collapse — a provider error
 *     like `ECONNREFUSED api.internal.example:443` should not carry the
 *     internal host name into logs or transcripts.
 *
 * Pattern set follows the documented command-code scrubbing mechanism;
 * all wording is original.
 */

const HOME_PATH_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/[A-Z]:[/\\](?:Users|Documents and Settings)[/\\][^\s:'"`,)}\]]+/gi, "[path]"],
  [/\/(?:Users|home|root)\/[^\s:'"`,)}\]]+/g, "[path]"],
  [/~\/[^\s:'"`,)}\]]+/g, "[path]"],
];

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b[0-9a-f]{32,}\b/gi, "[token]"],
  [/\b(?:sk|key|token|pat|ghp|gho|ghs|ghu|ghr|hf_)[-_][A-Za-z0-9_-]{10,}\b/g, "[apikey]"],
];

const NETWORK_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/https?:\/\/[^\s'"`,)\]}]+/gi, "[url]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[ip]"],
  [
    /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)\s+(?!\[)[^\s'"`,)\]}]+/g,
    "$1 [host]",
  ],
];

function applyAll(text: string, patterns: ReadonlyArray<[RegExp, string]>): string {
  return patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

/** Tier 1: secrets and personal paths only. */
export function scrubPII(text: string): string {
  return applyAll(text, [...HOME_PATH_PATTERNS, ...SECRET_PATTERNS]);
}

/** Tier 2: PII plus network facts (URLs, IPs, errno hostnames). */
export function scrubErrorText(text: string): string {
  return applyAll(scrubPII(text), NETWORK_PATTERNS);
}
