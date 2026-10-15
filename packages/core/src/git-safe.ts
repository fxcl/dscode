import { spawnSync } from "node:child_process";

/**
 * Non-interactive git: agent-driven git calls must never prompt for
 * credentials, touch the index locks another git process owns, wait on
 * fsmonitor, or re-run user hooks. Mirrors the documented command-code git
 * hardening; the helper here is dscode's own.
 */

/** Environment that makes git fail fast instead of prompting. */
export function gitSafeEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...extra,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
  };
}

/**
 * Arguments that keep agent-driven git side-effect free: no optional index
 * locks, no fsmonitor daemon, no user hooks.
 */
export function gitSafeArgs(args: readonly string[]): string[] {
  const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooksPath}`, ...args];
}

export interface GitSafeResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Synchronous hardened git for diagnostics and setup paths. */
export function runGitSafe(
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; maxBuffer?: number },
): GitSafeResult {
  const result = spawnSync("git", gitSafeArgs(args), {
    cwd: options.cwd,
    env: gitSafeEnv({ ...process.env }) as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBuffer ?? 16_777_216,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}
