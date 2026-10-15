import fs from "node:fs";
import path from "node:path";

export interface ShellInvocation {
  command: string;
  args: string[];
  description: string;
}

/**
 * Normalize PowerShell's exit code before the process exits. A bare
 * `-Command <cmd>` does NOT propagate native-command failures: in
 * `npm test; echo done` npm's failure is invisible to the exit code, and
 * cmdlet-only pipelines exit 0 regardless. Recording $? and $LASTEXITCODE
 * and exiting on them explicitly makes the process exit code mean what the
 * shell actually did. Design follows the documented command-code wrapper.
 */
export function buildPowerShellExitWrapper(innerCommand: string): string {
  return [
    innerCommand,
    "$__dsOk = $?",
    "$__dsExit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($__dsOk) { 0 } else { 1 }",
    "exit $__dsExit",
  ].join("\n");
}

/** Build a host-shell invocation without asking Node to reinterpret the command. */
export function hostShellCommand(shellCommand: string): ShellInvocation {
  if (process.platform === "win32") {
    const shell = resolveWindowsPowerShell();
    return {
      command: shell,
      args: ["-NoProfile", "-NonInteractive", "-Command", buildPowerShellExitWrapper(shellCommand)],
      description: `Windows host (${path.basename(shell)})`,
    };
  }

  const shell = process.env.SHELL ?? "/bin/sh";
  return {
    command: shell,
    args: ["-lc", shellCommand],
    description: "host",
  };
}

function resolveWindowsPowerShell(): string {
  const configured = process.env.DSCODE_SHELL?.trim();
  if (configured) return configured;

  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    const resolved = findExecutableOnPath(executable);
    if (resolved) return resolved;
  }
  return "powershell.exe";
}

function findExecutableOnPath(executable: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
