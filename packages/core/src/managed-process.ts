import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BoundedOutput } from "./process.js";
import { stripModelCredentialEnvironment } from "./providers.js";
import { sandboxCommand, type SandboxOptions } from "./sandbox.js";

/**
 * Pids of background children still alive at process exit are hard-killed so
 * an abrupt DSCode shutdown cannot leave orphans behind.
 */
const liveChildren = new Set<number>();
let exitSweepInstalled = false;

function ensureExitSweep(): void {
  if (exitSweepInstalled) return;
  exitSweepInstalled = true;
  process.once("exit", () => {
    for (const pid of liveChildren) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        } else {
          process.kill(-pid, "SIGKILL");
        }
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    liveChildren.clear();
  });
}

export interface ManagedProcessResult {
  processId: string;
  running: boolean;
  output: string;
  exitCode?: number | null;
  timedOut?: boolean;
  sandbox: string;
  command?: string;
}

interface ProcessRecord {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  output: BoundedOutput;
  pending: string;
  running: boolean;
  exitCode?: number | null;
  timedOut: boolean;
  sandbox: string;
  completion: Promise<void>;
  resolveCompletion: () => void;
  timeout: NodeJS.Timeout;
}

export class ManagedProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>();

  async start(
    command: string,
    options: {
      cwd: string;
      sandbox: SandboxOptions;
      yieldTimeMs: number;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<ManagedProcessResult> {
    const invocation = sandboxCommand(command, options.cwd, options.sandbox);
    const env = stripModelCredentialEnvironment({ ...process.env });

    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const id = randomUUID().slice(0, 12);
    let resolveCompletion = (): void => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: ProcessRecord = {
      id,
      child,
      command,
      output: new BoundedOutput(80_000),
      pending: "",
      running: true,
      timedOut: false,
      sandbox: invocation.description,
      completion,
      resolveCompletion,
      timeout: setTimeout(() => {
        record.timedOut = true;
        stopChild(record.child);
      }, options.timeoutMs),
    };
    record.timeout.unref();
    this.records.set(id, record);

    const append = (prefix: string, chunk: Buffer): void => {
      const text = `${prefix}${chunk.toString("utf8")}`;
      record.output.append(text);
      record.pending = `${record.pending}${text}`.slice(-80_000);
    };
    child.stdout.on("data", (chunk: Buffer) => append("", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("[stderr] ", chunk));
    if (child.pid !== undefined) {
      ensureExitSweep();
      liveChildren.add(child.pid);
    }
    child.once("error", (error) => {
      append("[error] ", Buffer.from(error.message));
    });
    // Exit-vs-stream settle race: grandchildren can hold stdout/stderr open
    // after the shell itself exited. If "exit" fired but "close" has not
    // within 100ms, finalize anyway so the task does not hang until timeout.
    child.once("exit", (exitCode) => {
      if (child.pid !== undefined) liveChildren.delete(child.pid);
      setTimeout(() => {
        if (!record.running) return;
        record.running = false;
        record.exitCode = record.exitCode ?? exitCode;
        clearTimeout(record.timeout);
        options.signal?.removeEventListener("abort", abort);
        record.resolveCompletion();
      }, 100).unref();
    });
    child.once("close", (exitCode) => {
      if (child.pid !== undefined) liveChildren.delete(child.pid);
      record.running = false;
      record.exitCode = exitCode;
      clearTimeout(record.timeout);
      options.signal?.removeEventListener("abort", abort);
      record.resolveCompletion();
    });

    const abort = (): void => stopChild(child);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, Math.min(options.yieldTimeMs, 30_000)));
        timer.unref();
      }),
    ]);
    return this.result(record);
  }

  async interact(
    processId: string,
    options: { chars?: string; yieldTimeMs: number; terminate?: boolean },
  ): Promise<ManagedProcessResult> {
    const record = this.records.get(processId);
    if (!record) throw new Error(`Unknown process: ${processId}`);
    if (options.terminate) {
      stopChild(record.child);
    } else if (options.chars && record.running) {
      record.child.stdin.write(options.chars);
    }

    if (record.running) {
      await Promise.race([
        record.completion,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, Math.min(options.yieldTimeMs, 30_000)));
          timer.unref();
        }),
      ]);
    }
    const result = this.result(record);
    if (!record.running) this.records.delete(processId);
    return result;
  }

  list(): Array<{ processId: string; running: boolean; sandbox: string }> {
    return [...this.records.values()].map((record) => ({
      processId: record.id,
      running: record.running,
      sandbox: record.sandbox,
    }));
  }

  /**
   * Non-destructive status probe: unlike interact(), it never consumes the
   * pending output or removes the record. Monitors use it to decide whether a
   * wakeup ping is due. A record removed by interact() after the process
   * finished reads as "unknown" here, and the monitor then disarms silently —
   * by design: whoever consumed the completion already saw the exit code.
   */
  describe(
    processId: string,
  ): { processId: string; running: boolean; exitCode?: number | null; command?: string; sandbox: string } | undefined {
    const record = this.records.get(processId);
    if (!record) return undefined;
    return {
      processId,
      running: record.running,
      ...(record.running ? {} : { exitCode: record.exitCode }),
      command: record.command,
      sandbox: record.sandbox,
    };
  }

  dispose(): void {
    for (const record of this.records.values()) {
      clearTimeout(record.timeout);
      stopChild(record.child);
    }
    this.records.clear();
  }

  private result(record: ProcessRecord): ManagedProcessResult {
    const pending = record.pending;
    record.pending = "";
    return {
      processId: record.id,
      running: record.running,
      output: pending || (record.running ? "(no new output)" : "(process completed)"),
      ...(!record.running ? { exitCode: record.exitCode } : {}),
      ...(record.timedOut ? { timedOut: true } : {}),
      sandbox: record.sandbox,
      command: record.command,
    };
  }
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return;
  signalProcessTree(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      signalProcessTree(child, "SIGKILL");
    }
  }, 1_500);
  timer.unref();
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill(signal));
    killer.once("close", (exitCode) => {
      if (exitCode !== 0 && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    });
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling only the direct child.
    }
  }
  child.kill(signal);
}
