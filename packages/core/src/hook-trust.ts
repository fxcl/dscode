import { createHash } from "node:crypto";
import { mkdir, readFile, stat, appendFile } from "node:fs/promises";
import path from "node:path";

/**
 * Hook trust and audit: project hook commands are arbitrary shell commands, so
 * every distinct command must be explicitly trusted (by SHA-256 of its exact
 * invocation) before it runs, and every execution is appended to a local audit
 * log. Mirrors the trust/audit layer of command-code's hook system.
 */

export const TRUSTED_HOOKS_VERSION = 1;
export const MAX_TRUSTED_HASHES = 500;

export interface TrustedHookRecord {
  hash: string;
  command: string;
  addedAt: number;
}

export interface TrustedHooksFile {
  version: number;
  hashes: TrustedHookRecord[];
}

export function hookCommandHash(command: string, args: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([command, args])).digest("hex");
}

export function trustedHooksPath(home: string): string {
  return path.join(home, "trusted-hooks.json");
}

export function hookAuditPath(home: string): string {
  return path.join(home, "audit", "hooks.jsonl");
}

export async function loadTrustedHookHashes(trustPath: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(trustPath, "utf8")) as Partial<TrustedHooksFile>;
    if (parsed.version !== TRUSTED_HOOKS_VERSION || !Array.isArray(parsed.hashes)) {
      return new Set();
    }
    return new Set(parsed.hashes.map((record) => record.hash));
  } catch {
    return new Set();
  }
}

export async function addTrustedHook(
  trustPath: string,
  hash: string,
  command: string,
): Promise<void> {
  let file: TrustedHooksFile = { version: TRUSTED_HOOKS_VERSION, hashes: [] };
  try {
    const parsed = JSON.parse(await readFile(trustPath, "utf8")) as Partial<TrustedHooksFile>;
    if (Array.isArray(parsed.hashes)) {
      file.hashes = parsed.hashes
        .filter((record) => record && typeof record.hash === "string")
        .slice(-MAX_TRUSTED_HASHES + 1);
    }
  } catch {
    // fresh file
  }
  file.hashes.push({ hash, command, addedAt: Date.now() });
  file.hashes = file.hashes.slice(-MAX_TRUSTED_HASHES);
  await mkdir(path.dirname(trustPath), { recursive: true });
  await writeFileTrusted(trustPath, file);
}

async function writeFileTrusted(trustPath: string, file: TrustedHooksFile): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(trustPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Pure partition: which hooks may run, and which need a trust decision. */
export function filterTrustedHooks<T extends { command: string; args: readonly string[] }>(
  hooks: readonly T[],
  trusted: ReadonlySet<string>,
): { allowed: T[]; untrusted: T[] } {
  const allowed: T[] = [];
  const untrusted: T[] = [];
  for (const hook of hooks) {
    (trusted.has(hookCommandHash(hook.command, hook.args)) ? allowed : untrusted).push(hook);
  }
  return { allowed, untrusted };
}

export interface HookAuditEntry {
  timestamp: number;
  event: string;
  tool?: string;
  commandHash: string;
  command: string;
  outcome: "success" | "blocked" | "error" | "untrusted-blocked";
  exitCode?: number;
  durationMs: number;
}

/** Append one audit record; the caller decides whether failures are fatal. */
export async function appendHookAudit(
  auditPath: string,
  entry: HookAuditEntry,
): Promise<void> {
  await mkdir(path.dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Audit path is usable only when the directory already exists or can be created. */
export async function ensureAuditReady(auditPath: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(auditPath), { recursive: true });
    await stat(path.dirname(auditPath));
    return true;
  } catch {
    return false;
  }
}
