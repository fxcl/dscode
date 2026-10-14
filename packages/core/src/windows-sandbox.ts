import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDSCodeHome } from "./home.js";
import type { SandboxOptions, SandboxedCommand } from "./sandbox.js";
import type { ShellInvocation } from "./shell.js";

const EXPERIMENTAL_ENV = "DSCODE_WINDOWS_SANDBOX";
const HELPER_ENV = "DSCODE_WINDOWS_SANDBOX_HELPER";
const STATE_ENV = "DSCODE_WINDOWS_SANDBOX_STATE";

interface WindowsSandboxStatus {
  ready: boolean;
  version?: number;
  missing?: string[];
}

interface WindowsSandboxRuntime {
  helperPath: string;
  statePath: string;
  shell?: ShellInvocation;
}

interface WindowsSandboxManifest {
  version: number;
  protocol: number;
  files: Record<string, string>;
}

export type WindowsSandboxLifecycleCommand = "setup" | "status" | "uninstall";

/** Why the native Windows sandbox cannot serve a command right now. */
export type WindowsSandboxAvailability = "ready" | "not-enabled" | "helper-missing" | "not-set-up";

export interface WindowsSandboxState {
  status: WindowsSandboxAvailability;
  /** Missing prerequisites reported by the helper (when it runs). */
  missing?: string[];
}

export function windowsNativeSandboxEnabled(): boolean {
  const value = process.env[EXPERIMENTAL_ENV]?.trim().toLowerCase();
  return process.platform === "win32" && (value === "1" || value === "true");
}

/**
 * Non-throwing availability probe. Separates the three Windows-only failure
 * shapes so callers can give the right instruction: the user never opted in,
 * the helper was not built, or the helper still needs its one-time setup.
 */
export function windowsNativeSandboxState(): WindowsSandboxState {
  if (process.platform !== "win32" || !windowsNativeSandboxEnabled()) {
    return { status: "not-enabled" };
  }
  let runtime: WindowsSandboxRuntime;
  try {
    runtime = configuredRuntime();
  } catch (error) {
    return { status: "helper-missing", missing: [(error as Error).message] };
  }
  const status = readStatus(runtime);
  return {
    status: status.ready ? "ready" : "not-set-up",
    ...(status.missing?.length ? { missing: status.missing } : {}),
  };
}

export function windowsNativeSandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
): SandboxedCommand {
  const runtime = configuredRuntime();
  const status = readStatus(runtime);
  if (!status.ready) {
    const details = status.missing?.length ? ` Missing: ${status.missing.join(", ")}.` : "";
    throw new Error(
      `The experimental Windows native sandbox is not ready.${details} ` +
        "Run the Windows sandbox setup command from an elevated terminal.",
    );
  }
  return buildWindowsSandboxCommand(shellCommand, cwd, options, runtime);
}

export function buildWindowsSandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
  runtime: WindowsSandboxRuntime,
): SandboxedCommand {
  const shell = runtime.shell ?? nativePowerShellCommand(shellCommand);
  const requestPath = path.join(
    os.tmpdir(),
    `dscode-windows-sandbox-${process.pid}-${randomUUID()}.json`,
  );
  fs.writeFileSync(
    requestPath,
    JSON.stringify({
      version: 1,
      state_path: runtime.statePath,
      mode: options.mode,
      network: options.network,
      command: shell.command,
      args: shell.args,
      cwd: path.resolve(cwd),
    }),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return {
    command: runtime.helperPath,
    args: ["run", requestPath],
    description: `Windows native sandbox (${options.mode}${options.network ? ", network" : ", no network"})`,
  };
}

/**
 * Shell used inside the native sandbox. PowerShell 7 is preferred (better
 * non-interactive behavior); the Windows PowerShell 5.1 that ships with the OS
 * is accepted as a fallback so a stock Windows host can still run sandboxed
 * commands. The fallback is reported in the invocation description rather than
 * hidden.
 */
function nativePowerShellCommand(shellCommand: string): ShellInvocation {
  const configured = process.env.DSCODE_SHELL?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (!fs.existsSync(resolved)) {
      throw new Error(`DSCODE_SHELL does not exist: ${resolved}`);
    }
    return powerShellInvocation(resolved, shellCommand);
  }
  const pathValue = process.env.PATH ?? "";
  const directories = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  // PowerShell 7 first, then the in-box 5.1.
  for (const name of ["pwsh.exe", "powershell.exe"]) {
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return powerShellInvocation(candidate, shellCommand);
    }
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  for (const relative of [
    path.join("System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join("System32", "WindowsPowerShell", "v1.0", "pwsh.exe"),
  ]) {
    const candidate = path.join(systemRoot, relative);
    if (fs.existsSync(candidate)) return powerShellInvocation(candidate, shellCommand);
  }
  throw new Error(
    "The Windows native sandbox needs PowerShell: install PowerShell 7 (pwsh.exe) " +
      "or point DSCODE_SHELL at a powershell.exe path.",
  );
}

function powerShellInvocation(command: string, shellCommand: string): ShellInvocation {
  const isPowerShell7 = path.basename(command).toLowerCase() === "pwsh.exe";
  return {
    command,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", shellCommand],
    description: isPowerShell7
      ? `PowerShell 7 (${path.basename(command)})`
      : `Windows PowerShell 5.1 (${path.basename(command)}) — install PowerShell 7 (pwsh.exe) for the preferred shell`,
  };
}

export function windowsNativeSandboxDescription(options: SandboxOptions): string {
  const state = windowsNativeSandboxState();
  if (state.status === "ready") return `Windows native ${options.mode}${options.network ? " + network" : ""}`;
  return `Windows native sandbox ${state.status} (${options.mode})`;
}

function configuredRuntime(): WindowsSandboxRuntime {
  const helperPath = process.env[HELPER_ENV]?.trim();
  const resolvedHelper = helperPath
    ? path.resolve(helperPath)
    : resolvePackagedHelper(process.arch);
  const resolvedState = path.resolve(
    process.env[STATE_ENV]?.trim() ?? path.join(getDSCodeHome(), "windows-sandbox", "state.bin"),
  );
  if (!fs.existsSync(resolvedHelper)) {
    throw new Error(`Windows sandbox helper is missing: ${resolvedHelper}`);
  }
  return { helperPath: resolvedHelper, statePath: resolvedState };
}

export function parseWindowsSandboxLifecycleCommand(
  argv: string[],
): WindowsSandboxLifecycleCommand | undefined {
  if (argv[0] !== "sandbox") return undefined;
  const command = argv[1];
  if (command === "setup" || command === "status" || command === "uninstall") {
    if (argv.length !== 2) throw new Error(`dscode sandbox ${command} does not accept arguments.`);
    return command;
  }
  throw new Error("Usage: dscode sandbox <setup|status|uninstall>");
}

export function runWindowsSandboxLifecycle(command: WindowsSandboxLifecycleCommand): void {
  if (process.platform !== "win32") {
    throw new Error("The native Windows sandbox lifecycle is available only on Windows.");
  }
  const runtime = configuredRuntime();
  fs.mkdirSync(path.dirname(runtime.statePath), { recursive: true, mode: 0o700 });
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(readStatus(runtime), null, 2)}\n`);
    return;
  }
  if (command === "setup" && readStatus(runtime).ready) {
    process.stdout.write("Windows native sandbox is already ready.\n");
    return;
  }
  runHelper(runtime, command === "setup" ? "setup-install" : "setup-uninstall");
  if (command === "setup") {
    const status = readStatus(runtime);
    if (!status.ready) throw new Error("Windows sandbox setup completed without becoming ready.");
    process.stdout.write("Windows native sandbox setup completed.\n");
  } else {
    process.stdout.write("Windows native sandbox uninstalled.\n");
  }
}

function runHelper(runtime: WindowsSandboxRuntime, action: string): void {
  const result = spawnSync(runtime.helperPath, [action, runtime.statePath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Windows sandbox ${action} failed (${result.status}).`);
  }
}

function resolvePackagedHelper(architecture: string): string {
  const target =
    architecture === "x64"
      ? "win32-x64"
      : architecture === "arm64"
        ? "win32-arm64"
        : undefined;
  if (!target) throw new Error(`Unsupported Windows sandbox architecture: ${architecture}`);
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const relative = `${target}/dscode-windows-sandbox.exe`;
  const helper = path.join(moduleRoot, "native", "windows-sandbox", relative);
  const manifestPath = path.join(moduleRoot, "native", "windows-sandbox", "manifest.json");
  if (!fs.existsSync(helper) || !fs.existsSync(manifestPath)) {
    throw new Error(
      `The packaged Windows sandbox helper is missing for ${target}. ` +
        `Set ${HELPER_ENV} only when testing a trusted development build.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WindowsSandboxManifest;
  if (manifest.version !== 1 || manifest.protocol !== 1) {
    throw new Error("The packaged Windows sandbox manifest is incompatible.");
  }
  const expected = manifest.files[relative];
  const actual = createHash("sha256").update(fs.readFileSync(helper)).digest("hex");
  if (!expected || actual !== expected) {
    throw new Error(`Windows sandbox helper checksum verification failed for ${target}.`);
  }
  return helper;
}

function readStatus(runtime: WindowsSandboxRuntime): WindowsSandboxStatus {
  const result = spawnSync(runtime.helperPath, ["setup-status", runtime.statePath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `Windows sandbox status failed with exit code ${result.status}.`,
    );
  }
  try {
    return JSON.parse(result.stdout) as WindowsSandboxStatus;
  } catch {
    throw new Error("Windows sandbox helper returned malformed status JSON.");
  }
}
