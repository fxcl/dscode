import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { classifyCommand } from "../packages/core/src/approval.js";
import {
  isReadOnlyPowerShellCommand,
  looksLikePowerShell,
} from "../packages/core/src/powershell-readonly.js";

describe("batch 18-2 — PowerShell read-only router", () => {
  it("routes cmdlet-shaped commands and leaves POSIX shapes alone", () => {
    expect(looksLikePowerShell("Get-ChildItem -Recurse")).toBe(true);
    expect(looksLikePowerShell("git status | Out-Host")).toBe(true);
    expect(looksLikePowerShell("$env:PATH")).toBe(true);
    expect(looksLikePowerShell("git status")).toBe(false);
    expect(looksLikePowerShell("rg pattern src")).toBe(false);
    expect(looksLikePowerShell("Get-Content")).toBe(true);
  });
});

describe("batch 18-2 — read-only classification", () => {
  it("approves simple and piped read-only cmdlets", () => {
    for (const command of [
      "Get-ChildItem",
      "Get-ChildItem -Recurse -Depth 2",
      "Get-Content .\\package.json -TotalCount 20",
      'Get-Content "C:\\Program Files\\app\\read me.txt"',
      "Get-Location",
      "Test-Path .\\src",
      "Get-FileHash .\\package.json -Algorithm SHA256",
      "Get-ChildItem | Measure-Object",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name",
      "Select-String -Path .\\src\\*.ts -Pattern TODO",
      "git status",
      "git log --oneline -5",
      "git diff",
      "git branch --show-current",
      "Get-Content a.txt | Out-String",
      "Get-Date -Format yyyyMMdd",
    ]) {
      expect(isReadOnlyPowerShellCommand(command), command).toBe(true);
    }
  });

  it("rejects execution constructs everywhere in the command", () => {
    for (const command of [
      "Get-ChildItem; Remove-Item x",
      "Get-Date && Remove-Item x",
      "Get-ChildItem $(Get-Date)",
      "$x = Get-Date; Get-Date",
      "Get-Content $env:SECRET",
      'Write-Output "$(whoami)"',
      "Write-Output `n",
      "Get-ChildItem { $_.Name }",
      "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
      "Invoke-Expression x",
      "Remove-Item x",
      "Start-Process notepad",
      "Set-Content a.txt x",
      "Out-File a.txt",
      "Invoke-WebRequest https://example.test",
      "Get-Content a > b",
      "Get-ChildItem 2>&1",
      "Get-Help # comment",
      "Get-Date --%",
      "Get-Thing",
      "get-childitem -UnknownParam x",
      "",
      "   ",
      ";;",
    ]) {
      expect(isReadOnlyPowerShellCommand(command), command).toBe(false);
    }
  });

  it("keeps aliases out of the read lane", () => {
    // `curl` and `rm` are PowerShell aliases (Invoke-WebRequest /
    // Remove-Item): full cmdlet names only, aliases always prompt.
    for (const command of ["curl https://example.test", "rm x", "del x", "sleep 30", "gci ."]) {
      expect(isReadOnlyPowerShellCommand(command), command).toBe(false);
    }
  });

  it("applies the git file-writing and branch-creation exclusions", () => {
    expect(isReadOnlyPowerShellCommand("git diff --output=patch.txt")).toBe(false);
    expect(isReadOnlyPowerShellCommand("git diff --ext-diff")).toBe(false);
    expect(isReadOnlyPowerShellCommand("git diff --stat")).toBe(true);
    expect(isReadOnlyPowerShellCommand("git branch")).toBe(true);
    expect(isReadOnlyPowerShellCommand("git branch --show-current")).toBe(true);
    expect(isReadOnlyPowerShellCommand("git branch feature-x")).toBe(false);
    expect(isReadOnlyPowerShellCommand("git commit -m x")).toBe(false);
  });

  it("respects quoted strings but not interpolation inside them", () => {
    expect(isReadOnlyPowerShellCommand('Get-Content "C:\\Program Files\\app\\log with spaces.txt"')).toBe(true);
    expect(isReadOnlyPowerShellCommand("Get-Content '$literal'")
    ).toBe(true);
    expect(isReadOnlyPowerShellCommand('Get-Content "$env:SECRET"')).toBe(false);
    expect(isReadOnlyPowerShellCommand('Write-Output "a$(b)"')).toBe(false);
  });

  it("classifies through the shared approval entry on the real platform", () => {
    expect(classifyCommand("Get-ChildItem -Recurse")).toBe(
      process.platform === "win32" ? "read-only" : "needs-approval",
    );
    expect(classifyCommand("Get-ChildItem; Remove-Item x")).toBe(
      process.platform === "win32" ? "needs-approval" : "dangerous",
    );
    // POSIX-shaped commands keep the legacy classification untouched.
    expect(classifyCommand("git status")).toBe("read-only");
    expect(classifyCommand("rm -rf /")).toBe("dangerous");
  });
});

function resolvePwsh(): string | undefined {
  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    const probe = spawnSync("where.exe", [executable], { stdio: "pipe" });
    if (probe.status === 0) return executable;
  }
  return undefined;
}

function spawnPowerShell(script: string): { status: number | null } {
  const shell = resolvePwsh() ?? "powershell.exe";
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status };
}

describe("batch 18-2 — real PowerShell smoke", () => {
  it.runIf(process.platform === "win32")("classified read-only commands are valid executable syntax", () => {
    // Every approved shape must actually parse and run under PowerShell;
    // a classifier that approved unparseable syntax would trade prompts
    // for errors.
    for (const command of [
      "Get-ChildItem -Recurse -Depth 1 | Out-Null",
      "Get-ChildItem | Measure-Object | Out-Null",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First 3 Name | Out-Null",
      "Test-Path . | Out-Null",
      "git rev-parse --git-dir | Out-Null",
    ]) {
      expect(isReadOnlyPowerShellCommand(command), command).toBe(true);
      expect(spawnPowerShell(command).status, command).toBe(0);
    }
  }, 60_000);
});
