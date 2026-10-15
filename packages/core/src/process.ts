import { spawn } from "node:child_process";
import { stripModelCredentialEnvironment } from "./providers.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

interface RunProcessOptions {
  cwd: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  maxOutputBytes?: number;
  shell?: boolean | string;
  /** Extra environment entries layered over the inherited environment. */
  envOverlay?: Record<string, string | undefined>;
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 200_000;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    const env = stripModelCredentialEnvironment({ ...process.env, ...(options.envOverlay ?? {}) });

    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      shell: options.shell ?? false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutBuffer = new BoundedOutput(Math.floor(maxOutputBytes / 2));
    const stderrBuffer = new BoundedOutput(Math.ceil(maxOutputBytes / 2));
    let timedOut = false;
    let settled = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") {
        stdoutBuffer.append(chunk.toString("utf8"));
      } else {
        stderrBuffer.append(chunk.toString("utf8"));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    const stop = (): void => {
      if (child.killed) return;
      signalProcessTree(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      setTimeout(
        () => {
          if (child.exitCode === null && child.signalCode === null) {
            signalProcessTree(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
          }
        },
        1_500,
      ).unref();
    };

    const onAbort = (): void => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) stop();

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: stdoutBuffer.value(),
        stderr: stderrBuffer.value(),
        exitCode,
        timedOut,
        truncated: stdoutBuffer.truncated || stderrBuffer.truncated,
      });
    });
  });
}

function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void,
): void {
  if (process.platform === "win32" || pid === undefined) {
    fallback();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    fallback();
  }
}

export class BoundedOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = "";
  private tail = "";
  private seen = 0;

  constructor(private readonly limit: number) {
    this.headLimit = Math.floor(limit * 0.75);
    this.tailLimit = limit - this.headLimit;
  }

  get truncated(): boolean {
    return this.seen > this.limit;
  }

  /** Total characters appended so far, including everything evicted. */
  get totalSeen(): number {
    return this.seen;
  }

  append(chunk: string): void {
    this.seen += chunk.length;
    let remaining = chunk;
    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, remaining.length);
      this.head += remaining.slice(0, take);
      remaining = remaining.slice(take);
    }
    if (remaining) {
      this.tail = `${this.tail}${remaining}`.slice(-this.tailLimit);
    }
  }

  value(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n... output truncated; tail follows ...\n${this.tail}`;
  }
}
