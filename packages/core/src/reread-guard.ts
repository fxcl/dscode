import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Reread guard: repeated identical reads of the same file region waste tokens
 * and usually mean the model is stuck in a loop. A small LRU keyed by
 * (path, mtime, size, line range) counts consecutive identical reads; on the
 * Nth the content is replaced by a short notice and the counter resets, so a
 * legitimate much-later reread still works. Design follows the documented
 * command-code repeated-read mechanism; all wording is original.
 */

export const REREAD_NOTICE_THRESHOLD = 3;
export const REREAD_MAX_ENTRIES = 256;

/**
 * Path identity: resolve symlinks to a canonical key so `./src/a.ts`,
 * `src/../src/a.ts`, and a symlinked alias count as the same read. When
 * realpath fails (missing file, broken link), fall back to the deepest
 * EXISTING ancestor's realpath plus the missing tail — the documented
 * command-code canonical-key mechanism.
 */
export async function canonicalKey(absolutePath: string): Promise<string> {
  const normalized = path.normalize(absolutePath);
  try {
    return path.normalize(await realpath(normalized));
  } catch {
    // fall through to the ancestor walk
  }
  let tail: string[] = [];
  let current = normalized;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return normalized; // reached the root; give up gracefully
    tail.unshift(path.basename(current));
    current = parent;
    try {
      const resolvedParent = path.normalize(await realpath(current));
      return path.normalize(path.join(resolvedParent, ...tail));
    } catch {
      continue;
    }
  }
}

export interface ReadObservation {
  path: string;
  mtimeMs?: number | undefined;
  size?: number | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}

export interface RereadGuard {
  /** Record one read; returns a notice string when this read should be withheld. */
  observe(read: ReadObservation): string | undefined;
  /** Drop all state (file changed elsewhere, session switch, tests). */
  reset(): void;
}

export function createRereadGuard(options?: {
  threshold?: number | undefined;
  maxEntries?: number | undefined;
}): RereadGuard {
  const threshold = options?.threshold ?? REREAD_NOTICE_THRESHOLD;
  const maxEntries = options?.maxEntries ?? REREAD_MAX_ENTRIES;
  const counts = new Map<string, number>();

  const keyOf = (read: ReadObservation): string =>
    [read.path, read.mtimeMs ?? "?", read.size ?? "?", read.lineStart ?? 1, read.lineEnd ?? "eof"].join("|");

  return {
    observe(read) {
      const key = keyOf(read);
      const next = (counts.get(key) ?? 0) + 1;
      counts.delete(key);
      counts.set(key, next);
      if (counts.size > maxEntries) {
        const oldest = counts.keys().next().value;
        if (oldest !== undefined) counts.delete(oldest);
      }
      if (next < threshold) return undefined;
      counts.set(key, 0);
      const range =
        read.lineStart !== undefined || read.lineEnd !== undefined
          ? ` (lines ${read.lineStart ?? 1}-${read.lineEnd ?? "end"})`
          : "";
      return [
        `Reread notice: this exact region of ${read.path}${range} has already been returned ${next} times and has not changed (same mtime and size).`,
        "Do not read it again; work from the content above. If something appears wrong, use search_files or exec_command to investigate the specific spot instead.",
      ].join("\n");
    },
    reset() {
      counts.clear();
    },
  };
}
