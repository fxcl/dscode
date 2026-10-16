import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Persistent command allow rules: session grants live in memory only, so
 * the same approved command prompts again in every new session. This store
 * keeps project-level rules in `.dscode/permissions.json` (shareable with a
 * team) covering two dimensions:
 *
 *   - access boundary ("network" / "host"): grants the escalated boundary
 *     without prompting, mirroring the existing session-grant semantics;
 *   - danger ("dangerous"): a command the classifier flags as destructive
 *     that the user decided is fine to run unattended.
 *
 * Rules are exact commands or prefix patterns ending in `*` (`pnpm test*`).
 * Matching is normalization-based (collapsed whitespace), the same shape as
 * session grants. Reads are best-effort; a missing or corrupt file means
 * "no rules". Design follows the documented command-code declarative
 * permission-rule mechanism, narrowed to DSCode's actual approval surface;
 * all wording is original.
 */

export const PERMISSIONS_FILE_VERSION = 1;
export const MAX_RULES = 200;

export interface PermissionRule {
  /** "network"/"host": elevated boundary; "dangerous": risky classifier verdict. */
  kind: "network" | "host" | "dangerous";
  /** Exact command (normalized) or prefix pattern ending in "*". */
  pattern: string;
  /** Epoch millis the rule was added. */
  addedAt: number;
}

export interface PermissionsFile {
  version: typeof PERMISSIONS_FILE_VERSION;
  rules: PermissionRule[];
}

export function permissionsFileFor(cwd: string): string {
  return path.join(cwd, ".dscode", "permissions.json");
}

/** Same normalization the session-grant path uses. */
export function normalizeRuleCommand(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

/** Expand the trailing `*` into a matcher; undefined when the pattern is unusable. */
export function ruleMatcher(pattern: string): ((command: string) => boolean) | undefined {
  const normalized = normalizeRuleCommand(pattern);
  if (normalized.length === 0) return undefined;
  if (!normalized.endsWith("*")) {
    return (command) => normalizeRuleCommand(command) === normalized;
  }
  const prefix = normalized.slice(0, -1);
  if (prefix.length === 0) return undefined; // bare "*" would allow everything
  return (command) => normalizeRuleCommand(command).startsWith(prefix);
}

export async function readPermissionRules(cwd: string): Promise<PermissionRule[]> {
  try {
    const parsed = JSON.parse(await readFile(permissionsFileFor(cwd), "utf8")) as Partial<PermissionsFile>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) return [];
    return parsed.rules.filter(
      (rule): rule is PermissionRule =>
        typeof rule === "object" &&
        rule !== null &&
        (rule.kind === "network" || rule.kind === "host" || rule.kind === "dangerous") &&
        typeof rule.pattern === "string" &&
        typeof rule.addedAt === "number",
    );
  } catch {
    return [];
  }
}

/** Append one rule (deduplicating identical kind+pattern). Best-effort. */
export async function addPermissionRule(cwd: string, kind: PermissionRule["kind"], command: string): Promise<void> {
  const normalized = normalizeRuleCommand(command);
  if (normalized.length === 0 || !ruleMatcher(normalized)) return;
  const file = permissionsFileFor(cwd);
  const rules = await readPermissionRules(cwd);
  if (rules.some((rule) => rule.kind === kind && rule.pattern === normalized)) return;
  if (rules.length >= MAX_RULES) return;
  rules.push({ kind, pattern: normalized, addedAt: Date.now() });
  await mkdir(path.dirname(file), { recursive: true });
  const payload: PermissionsFile = { version: PERMISSIONS_FILE_VERSION, rules };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** Remove rules matching an exact pattern (any kind) or a single index. */
export async function removePermissionRule(cwd: string, selector: string): Promise<number> {
  const rules = await readPermissionRules(cwd);
  const remaining = rules.filter(
    (rule) => rule.pattern !== normalizeRuleCommand(selector) && `#${rules.indexOf(rule) + 1}` !== selector,
  );
  const removed = rules.length - remaining.length;
  if (removed === 0) return 0;
  const file = permissionsFileFor(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  const payload: PermissionsFile = { version: PERMISSIONS_FILE_VERSION, rules: remaining };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return removed;
}

export async function clearPermissionRules(cwd: string): Promise<void> {
  const file = permissionsFileFor(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  const payload: PermissionsFile = { version: PERMISSIONS_FILE_VERSION, rules: [] };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** First matching rule for a command, or undefined. */
export function matchRule(rules: readonly PermissionRule[], kind: PermissionRule["kind"], command: string): PermissionRule | undefined {
  for (const rule of rules) {
    if (rule.kind !== kind) continue;
    const matcher = ruleMatcher(rule.pattern);
    if (matcher?.(command)) return rule;
  }
  return undefined;
}

/** Format rules for /permissions display. */
export function formatPermissionRules(rules: readonly PermissionRule[]): string {
  if (rules.length === 0) {
    return "No remembered permissions. Approvals are per-session unless you choose \"Allow and remember\".";
  }
  return rules
    .map((rule, index) => `${index + 1}. [${rule.kind}] ${rule.pattern}`)
    .join("\n");
}
