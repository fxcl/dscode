/**
 * Tiny shared type guards for untyped JSON values. Centralized so call sites
 * stay in sync (web-search, plan, auth, deepseek, settings, …).
 */

/** Narrows arbitrary JSON values to non-array object records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the trimmed string when value is a non-empty string, otherwise undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}