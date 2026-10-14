import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stripModelCredentialEnvironment } from "./providers.js";
import type { SandboxMode } from "./runtime-options.js";
import { hostShellCommand } from "./shell.js";
import {
  windowsNativeSandboxCommand,
  windowsNativeSandboxState,
} from "./windows-sandbox.js";

export interface SandboxOptions {
  mode: SandboxMode;
  network: boolean;
}

export interface SandboxedCommand {
  command: string;
  args: string[];
  description: string;
}

/** Which backend can serve a given mode here, and why not if none can. */
export type SandboxBackend =
  | "host"
  | "windows-native"
  | "seatbelt"
  | "docker"
  | "unavailable";

export interface SandboxResolution {
  backend: SandboxBackend;
  /** Human-readable status for /status, /doctor, and the status bar. */
  description: string;
  /** Why nothing can serve the mode (set only when backend is "unavailable"). */
  reason?: string;
}

/**
 * Adaptive backend selection: probe every backend this platform could offer
 * and report the best one available, so /doctor can explain the situation
 * before a command ever fails. Never silently weakens the requested mode.
 */
export function resolveSandboxBackend(options: SandboxOptions): SandboxResolution {
  if (options.mode === "danger-full-access") {
    return { backend: "host", description: "host access" };
  }
  const network = options.network ? " + network" : "";

  if (process.platform === "win32") {
    const state = windowsNativeSandboxState();
    if (state.status === "ready") {
      return { backend: "windows-native", description: `Windows native ${options.mode}${network}` };
    }
    return {
      backend: "unavailable",
      description: `Windows native sandbox ${state.status} (${options.mode})`,
      reason: `No OS sandbox backend can serve ${options.mode} on win32. ${windowsUnavailableReason(state)}`,
    };
  }

  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    return { backend: "seatbelt", description: `Seatbelt ${options.mode}${network}` };
  }
  if (process.env.DSCODE_SANDBOX_IMAGE && commandExists("docker")) {
    return {
      backend: "docker",
      description: `Docker ${process.env.DSCODE_SANDBOX_IMAGE} (${options.mode}${network})`,
    };
  }
  return {
    backend: "unavailable",
    description: `unavailable (${options.mode})`,
    reason: `No OS sandbox backend can serve ${options.mode} on ${process.platform}. ${otherPlatformUnavailableReason(options)}`,
  };
}

function windowsUnavailableReason(state: ReturnType<typeof windowsNativeSandboxState>): string {
  const hostFallback =
    "For a trusted workspace, run with --sandbox danger-full-access (commands then run on the host with no isolation).";
  if (state.status === "helper-missing") {
    return (
      "The Windows sandbox helper was not found in this build. Rebuild it with " +
      `"pnpm build:windows-sandbox" (requires a Go toolchain), then run "dscode sandbox setup" from an elevated terminal. ` +
      hostFallback
    );
  }
  if (state.status === "not-set-up") {
    return (
      'The Windows native sandbox is enabled but not set up yet — run "dscode sandbox setup" from an elevated terminal. ' +
      hostFallback
    );
  }
  return (
    'This build has a native Windows sandbox but it is off. Enable it with DSCODE_WINDOWS_SANDBOX=1, ' +
    'then run "dscode sandbox setup" once from an elevated terminal. ' +
    hostFallback
  );
}

function otherPlatformUnavailableReason(options: SandboxOptions): string {
  if (process.platform === "darwin") {
    return (
      "macOS Seatbelt (sandbox-exec) was not found. Set DSCODE_SANDBOX_IMAGE to a trusted Docker image, " +
      "or run with --sandbox danger-full-access for a trusted workspace."
    );
  }
  if (process.platform === "linux") {
    return (
      "No sandbox backend was found on this Linux host. Set DSCODE_SANDBOX_IMAGE to a trusted Docker image " +
      `to sandbox ${options.mode}, or run with --sandbox danger-full-access for a trusted workspace.`
    );
  }
  return (
    `No OS sandbox backend supports ${options.mode} on this platform. ` +
    "Use --sandbox danger-full-access only for a trusted workspace."
  );
}

export function sandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
): SandboxedCommand {
  if (options.mode === "danger-full-access") {
    return hostShellCommand(shellCommand);
  }

  if (process.platform === "win32") {
    return windowsNativeSandboxCommand(shellCommand, cwd, options);
  }

  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    const shell = process.env.SHELL ?? "/bin/sh";
    const workspace = fs.realpathSync(cwd);
    const temporary = fs.realpathSync(os.tmpdir());
    const writable =
      options.mode === "workspace-write"
        ? [workspace, temporary, "/dev/null", "/dev/tty"]
        : ["/dev/null", "/dev/tty"];
    const rules = [
      "(version 1)",
      "(allow default)",
      writable.length === 0
        ? "(deny file-write*)"
        : `(deny file-write* (require-not (require-any ${writable
            .map((directory) => `(subpath "${escapeSeatbelt(directory)}")`)
            .join(" ")})))`,
      options.network ? "" : "(deny network*)",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", rules, shell, "-lc", shellCommand],
      description: `macOS Seatbelt (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  const image = process.env.DSCODE_SANDBOX_IMAGE;
  if (image && commandExists("docker")) {    const networkArgs = options.network ? [] : ["--network", "none"];
    const userArgs =
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : [];
    const mount = options.mode === "read-only" ? `${cwd}:/workspace:ro` : `${cwd}:/workspace`;
    const readOnlyArgs =
      options.mode === "read-only"
        ? ["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m"]
        : [];
    return {
      command: "docker",
      args: [
        "run",
        "--rm",
        "-i",
        ...userArgs,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        ...networkArgs,
        ...readOnlyArgs,
        "-v",
        mount,
        "-w",
        "/workspace",
        image,
        "/bin/sh",
        "-lc",
        shellCommand,
      ],
      description: `Docker ${image} (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  throw new Error(
    `No OS sandbox backend is available for ${options.mode} on ${process.platform}. ` +
      (resolveSandboxBackend(options).reason ??
        "Use --sandbox danger-full-access only for a trusted workspace."),
  );
}

export function sandboxDescription(options: SandboxOptions): string {
  return resolveSandboxBackend(options).description;
}

/** Actionable explanation for /doctor when no backend can serve the mode. */
export function sandboxUnavailableGuidance(options: SandboxOptions): string | undefined {
  return resolveSandboxBackend(options).reason;
}

export function executeSandboxedCommand(
  shellCommand: string,
  cwd: string,
  sandbox: SandboxOptions,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ exitCode: number | null }> {
  const invocation = sandboxCommand(shellCommand, cwd, sandbox);
  return new Promise((resolve, reject) => {
    const environment = stripModelCredentialEnvironment({ ...(options.env ?? process.env) });
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const stop = (): void => {
      if (child.killed) return;
      signalSandboxProcess(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      setTimeout(
        () => {
          if (child.exitCode === null && child.signalCode === null) {
            signalSandboxProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
          }
        },
        1_500,
      ).unref();
    };
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(stop, Math.max(1, options.timeout));
    timer?.unref();
    const abort = (): void => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode });
    });
  });
}

function signalSandboxProcess(
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

function escapeSeatbelt(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  return pathValue
    .split(path.delimiter)
    .some((directory) => fs.existsSync(path.join(directory, command)));
}
