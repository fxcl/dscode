import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Instance lock: a per-project coordination file that lets exactly one
 * DSCode process drive the autonomous surfaces (background schedules, goal
 * loop resumption, wakeups, monitor pings) while a second instance on the
 * same project defers. Without it, two terminals on one repo double-inject
 * scheduled turns and race the session file.
 *
 * The lock file holds the holder's pid; acquisition is the atomic-exclusive
 * `wx` write, a dead holder's lock is stolen after bounded retries, and
 * loss is detected by polling (fs.watch is best-effort and not portable
 * enough to trust alone). Design follows the documented command-code
 * remote-lock mechanism; all wording is original.
 */

export interface InstanceLockInfo {
  pid: number;
  cwd: string;
  startedAt: string;
  /** Populated by newer writers; tolerated as absent. */
  version?: number | undefined;
}

export function instanceLockPathFor(cwd: string): string {
  return path.join(cwd, ".dscode", "instance.lock");
}

/** True when the pid belongs to a live process (EPERM counts as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function parseLockFile(raw: string): InstanceLockInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceLockInfo>;
    if (typeof parsed?.pid === "number" && typeof parsed?.cwd === "string") {
      return {
        pid: parsed.pid,
        cwd: parsed.cwd,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
      };
    }
  } catch {
    // corrupt or partially written lock: treat as absent
  }
  return undefined;
}

export async function readInstanceLock(lockPath: string): Promise<InstanceLockInfo | undefined> {
  try {
    const info = parseLockFile(await readFile(lockPath, "utf8"));
    if (info && isProcessAlive(info.pid)) return info;
    return undefined;
  } catch {
    return undefined;
  }
}

export type AcquireOutcome =
  | { ok: true }
  | { ok: false; holder: InstanceLockInfo };

/**
 * Acquire the project lock. `wx` gives cross-platform atomic exclusivity;
 * on collision, a lock whose holder is dead is removed and retried (3
 * attempts) so a crashed session cannot block scheduling forever.
 */
export async function acquireInstanceLock(
  lockPath: string,
  holder: Omit<InstanceLockInfo, "version">,
  attempts = 3,
): Promise<AcquireOutcome> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const payload = `${JSON.stringify({ ...holder, version: 1 }, null, 2)}\n`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holderInfo = await readInstanceLock(lockPath);
    if (holderInfo && holderInfo.pid !== holder.pid) {
      return { ok: false, holder: holderInfo };
    }
    await rm(lockPath, { force: true }).catch(() => {});
  }
  const remaining = await readInstanceLock(lockPath);
  return remaining ? { ok: false, holder: remaining } : { ok: false, holder: { ...holder, startedAt: "" } };
}

/** Release only our own lock; never delete a successor's. */
export async function releaseInstanceLock(lockPath: string, pid: number): Promise<void> {
  const info = await readInstanceLock(lockPath);
  if (info && info.pid !== pid) return;
  await rm(lockPath, { force: true }).catch(() => {});
}

export interface InstanceLockWatch {
  stop(): void;
}

/**
 * Poll the lock and report loss the moment another live pid holds it. The
 * watcher never throws: a missing directory or unreadable file only means
 * "keep checking".
 */
export function watchInstanceLock(
  lockPath: string,
  ownPid: number,
  onLost: (holder: InstanceLockInfo) => void,
  pollMs = 5_000,
): InstanceLockWatch {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (!existsSync(lockPath)) return;
    let info: InstanceLockInfo | undefined;
    try {
      info = parseLockFile(readFileSync(lockPath, "utf8"));
    } catch {
      return;
    }
    if (info && info.pid !== ownPid && isProcessAlive(info.pid)) {
      stopped = true;
      clearInterval(timer);
      onLost(info);
    }
  }, pollMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
