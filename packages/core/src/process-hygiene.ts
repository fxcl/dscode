import process from "node:process";

/**
 * Process-level error hygiene, in three tiers:
 *
 *   1. Benign stream-write failures on stdout (the `cmd | head -20`
 *      pattern: the reader closes, our write gets EPIPE) resolve to a
 *      clean exit code 0 — the downstream consumer saw a normal end;
 *   2. The same failures on stderr are swallowed outright;
 *   3. A benign uncaught exception (one that surfaced only after the
 *      above handlers were armed) is reported and survived; everything
 *      else crashes with the normal nonzero exit.
 *
 * Without this, piping DSCode's output anywhere that stops reading early
 * prints a full stack trace and exits nonzero — hostile to every Unix
 * composition. Detection follows the documented command-code benign
 * write-error mechanism; all wording is original.
 */

const BENIGN_STREAM_CODES = ["EPIPE", "ECONNRESET", "EOF"] as const;

export function isBenignStreamWriteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; syscall?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const syscall = typeof candidate.syscall === "string" ? candidate.syscall : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return (
    BENIGN_STREAM_CODES.some((benign) => message.startsWith(`write ${benign}`)) ||
    (syscall === "write" && (BENIGN_STREAM_CODES as readonly string[]).includes(code))
  );
}

/**
 * Arm the handlers. Idempotent; call once at process start, before any
 * output is produced.
 */
export function installProcessErrorHygiene(): void {
  process.stdout.on("error", (error: unknown) => {
    if (!isBenignStreamWriteError(error)) throw error;
    // Downstream closed on us; end cleanly so `| head` composes.
    process.exit(0);
  });
  process.stderr.on("error", (error: unknown) => {
    if (!isBenignStreamWriteError(error)) throw error;
    // Losing stderr is never fatal to the task itself.
  });
  process.on("uncaughtException", (error: unknown) => {
    if (isBenignStreamWriteError(error)) {
      // The write handlers above are not always reached first (a write
      // flushed from a detached timer can surface here instead).
      process.exit(0);
    }
    process.exitCode = 1;
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`DSCode crashed: ${message}\n`);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    process.exitCode = 1;
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`DSCode unhandled rejection: ${message}\n`);
  });
}
