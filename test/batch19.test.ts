import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.js";
import {
  describeSleepOutcome,
  formatDurationMs,
  parseUntil,
  registerSleepTool,
  resolveSleepDuration,
  MAX_SLEEP_MS,
} from "../packages/core/src/sleep.js";
import { buildPowerShellExitWrapper } from "../packages/core/src/shell.js";
import { blockedSleepMessage } from "../packages/core/src/command-semantics.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("batch 19 — sleep duration parsing", () => {
  const NOW = new Date("2026-07-11T10:00:00").getTime();

  it("parses a wall-clock time later today", () => {
    const delta = parseUntil("10:30", NOW);
    expect(delta).toBe(30 * 60_000);
  });

  it("wraps a past wall-clock time to tomorrow", () => {
    const delta = parseUntil("09:59", NOW);
    expect(delta).toBe(24 * 60 * 60_000 - 60_000);
    const withSeconds = parseUntil("09:59:30", NOW);
    expect(withSeconds).toBe(24 * 60 * 60_000 - 30_000);
  });

  it("rejects impossible wall-clock values", () => {
    expect(parseUntil("25:00", NOW)).toBeUndefined();
    expect(parseUntil("10:60", NOW)).toBeUndefined();
    expect(parseUntil("10:00:61", NOW)).toBeUndefined();
    expect(parseUntil("tomorrow-ish", NOW)).toBeUndefined();
    expect(parseUntil("", NOW)).toBeUndefined();
  });

  it("parses ISO-8601 timestamps as absolute deltas", () => {
    // Build the target from NOW itself so the assertion is timezone-proof.
    const delta = parseUntil(new Date(NOW + 30 * 60_000).toISOString(), NOW);
    expect(delta).toBeGreaterThan(29 * 60_000);
    expect(delta).toBeLessThanOrEqual(31 * 60_000);
  });

  it("clamps past ISO timestamps to zero", () => {
    expect(parseUntil("2020-01-01T00:00:00Z", NOW)).toBe(0);
  });
});

describe("batch 19 — sleep duration resolution", () => {
  it("passes normal durations through untouched", () => {
    expect(resolveSleepDuration(30_000)).toEqual({
      requestedMs: 30_000,
      effectiveMs: 30_000,
      clamp: "none",
    });
  });

  it("caps at the per-call maximum and keeps the request for the note", () => {
    const resolved = resolveSleepDuration(60 * 60_000);
    expect(resolved.effectiveMs).toBe(MAX_SLEEP_MS);
    expect(resolved.clamp).toBe("max-capped");
    expect(resolved.requestedMs).toBe(60 * 60_000);
  });

  it("describes completion, interruption, and the cap", () => {
    const completed = describeSleepOutcome({
      end: "completed",
      sleptMs: 30_000,
      resolved: { requestedMs: 30_000, effectiveMs: 30_000, clamp: "none" },
    });
    expect(completed).toContain("Slept for 30s");

    const interrupted = describeSleepOutcome({
      end: "interrupted",
      sleptMs: 5_000,
      resolved: { requestedMs: 30_000, effectiveMs: 30_000, clamp: "none" },
    });
    expect(interrupted).toContain("interrupted by the user");
    expect(interrupted).not.toContain("capped");

    const capped = describeSleepOutcome({
      end: "completed",
      sleptMs: MAX_SLEEP_MS,
      resolved: { requestedMs: 45 * 60_000, effectiveMs: MAX_SLEEP_MS, clamp: "max-capped" },
    });
    expect(capped).toContain("capped at the maximum");
    expect(capped).toContain("35m remaining");
  });

  it("formats durations for humans", () => {
    expect(formatDurationMs(500)).toBe("500ms");
    expect(formatDurationMs(30_000)).toBe("30s");
    expect(formatDurationMs(90_000)).toBe("1m 30s");
    expect(formatDurationMs(10 * 60_000)).toBe("10m");
  });

  it("registers the sleep tool with an exclusive-argument description", () => {
    const registered: Array<{ name: string }> = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool),
    } as unknown as ExtensionAPI;
    registerSleepTool(pi);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("sleep");
  });

  it("points the foreground-sleep guard at the new tools", () => {
    const message = blockedSleepMessage(30);
    expect(message).toContain("sleep tool");
    expect(message).toContain("wait_for");
  });
});

describe("batch 19 — PowerShell exit-code wrapper", () => {
  it("appends the exit normalization after the command", () => {
    const script = buildPowerShellExitWrapper("Write-Output hi");
    expect(script.split("\n")).toEqual([
      "Write-Output hi",
      "$__dsOk = $?",
      "$__dsExit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($__dsOk) { 0 } else { 1 }",
      "exit $__dsExit",
    ]);
  });

  it.runIf(process.platform === "win32")("propagates native failures a bare -Command would swallow", () => {
    const shell = process.platform === "win32" ? (resolvePwsh() ?? "powershell.exe") : "pwsh";
    const inner = `& '${process.execPath.replaceAll("'", "''")}' '-e' 'process.exit(5)'; Write-Output done`;

    // Bare -Command: the native failure is invisible, exit code is 0.
    const bare = spawnPowerShell(shell, ["-NoProfile", "-NonInteractive", "-Command", inner]);
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain("done");

    // Wrapped: the native failure becomes the process exit code.
    const wrapped = spawnPowerShell(shell, ["-NoProfile", "-NonInteractive", "-Command", buildPowerShellExitWrapper(inner)]);
    expect(wrapped.status).toBe(5);
    expect(wrapped.stdout).toContain("done");
    // Two full PowerShell cold starts under concurrent load can exceed
    // vitest's 5s default; this assertion pair needs real process spawns.
  }, 60_000);

  it.runIf(process.platform === "win32")("keeps successful commands at exit code 0", () => {
    const shell = resolvePwsh() ?? "powershell.exe";
    const wrapped = spawnPowerShell(shell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildPowerShellExitWrapper("Get-ChildItem . | Out-Null"),
    ]);
    expect(wrapped.status).toBe(0);
  }, 60_000);
});

function resolvePwsh(): string | undefined {
  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    const probe = spawnSync("where.exe", [executable], { stdio: "pipe" });
    if (probe.status === 0) return executable;
  }
  return undefined;
}

function spawnPowerShell(shell: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(shell, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function nodePrintThenExitAfter(output: string, outputAtMs: number, exitAtMs: number): string {
  const script = `setTimeout(() => process.stdout.write(${JSON.stringify(output)}), ${outputAtMs}); setTimeout(() => process.exit(0), ${exitAtMs});`;
  if (process.platform === "win32") {
    return `& '${process.execPath.replaceAll("'", "''")}' '-e' '${script.replaceAll("'", "''")}'`;
  }
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script}'`;
}

describe("batch 19 — managed process waitFor", () => {
  it("returns already-finished for unknown and completed processes", { timeout: 60_000 }, async () => {
    const registry = new ManagedProcessRegistry();
    try {
      expect((await registry.waitFor("nope", { mode: "exit", timeoutMs: 200 })).outcome).toBe("already-finished");

      const started = await registry.start(nodePrintThenExitAfter("done", 0, 0), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 15_000,
      });
      // Node cold-start can outrun any fixed yield on slow machines; wait
      // for the exit itself instead of assuming a deadline.
      const exited = await registry.waitFor(started.processId, { mode: "exit", timeoutMs: 10_000, tickMs: 50 });
      expect(exited.outcome).toBe("exited");
      expect((await registry.waitFor(started.processId, { mode: "output", timeoutMs: 200 })).outcome).toBe(
        "already-finished",
      );
    } finally {
      registry.dispose();
    }
  });

  it("wakes the moment new output arrives instead of the full window", { timeout: 60_000 }, async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(nodePrintThenExitAfter("tick", 400, 4_000), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 10_000,
      });
      const wait = await registry.waitFor(started.processId, { mode: "output", timeoutMs: 5_000, tickMs: 50 });
      expect(wait.outcome).toBe("new-output");
      // The output lands at ~400ms; a blind 5s window would have waited the
      // full budget. Allow generous slack for slow CI machines.
      expect(wait.waitedMs).toBeLessThan(3_000);
      registry.dispose();
    } finally {
      registry.dispose();
    }
  });

  it("resolves exit before the timeout and times out when nothing happens", { timeout: 60_000 }, async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const quick = await registry.start(nodePrintThenExitAfter("bye", 0, 300), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 10_000,
      });
      const exited = await registry.waitFor(quick.processId, { mode: "exit", timeoutMs: 5_000, tickMs: 50 });
      expect(exited.outcome).toBe("exited");
      expect(exited.waitedMs).toBeLessThan(4_500);

      const slow = await registry.start(nodePrintThenExitAfter("late", 5_000, 9_000), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 15_000,
      });
      const timedOut = await registry.waitFor(slow.processId, { mode: "output", timeoutMs: 400, tickMs: 50 });
      expect(timedOut.outcome).toBe("timed-out");
      expect(timedOut.waitedMs).toBeGreaterThanOrEqual(400);
      expect(registry.describe(slow.processId)?.running).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it("ends the wait when the abort signal fires", { timeout: 60_000 }, async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const slow = await registry.start(nodePrintThenExitAfter("late", 5_000, 9_000), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 15_000,
      });
      const controller = new AbortController();
      const waiting = registry.waitFor(slow.processId, {
        mode: "output",
        timeoutMs: 10_000,
        signal: controller.signal,
        tickMs: 50,
      });
      setTimeout(() => controller.abort(), 200);
      const outcome = await waiting;
      expect(outcome.outcome).toBe("interrupted");
    } finally {
      registry.dispose();
    }
  });

  it("reports output size without consuming pending output", { timeout: 60_000 }, async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(nodePrintThenExitAfter("measure-me", 0, 5_000), {
        cwd: os.tmpdir(),
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 0,
        timeoutMs: 15_000,
      });
      // Node cold-starts slower than any fixed yield on slow machines; wait
      // for the output event instead of assuming a deadline.
      const wait = await registry.waitFor(started.processId, { mode: "output", timeoutMs: 5_000, tickMs: 50 });
      expect(wait.outcome).toBe("new-output");
      expect(registry.outputSize(started.processId)).toBeGreaterThan(0);
      const polled = await registry.interact(started.processId, { yieldTimeMs: 100 });
      expect(polled.output).toContain("measure-me");
    } finally {
      registry.dispose();
    }
  });
});

describe("batch 19 — wait note wording", () => {
  it("keeps the tool contract in the parameter description", async () => {
    // The write_stdin extension lives behind the pi framework; assert the
    // schema-level contract indirectly through the extension source instead.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(import.meta.dirname, "../packages/core/src/dscode-extension.ts"), "utf8");
    expect(source).toContain('wait_for: Type.Optional');
    expect(source).toContain('"output"');
    expect(source).toContain('"exit"');
    expect(source).toContain("Call write_stdin again with wait_for to keep waiting");
  });
});
