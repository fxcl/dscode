import process from "node:process";
import type { PermissionMode } from "./config.js";
import { isReadOnlyPowerShellCommand, looksLikePowerShell } from "./powershell-readonly.js";

export type Confirmation = (message: string) => Promise<boolean>;

export interface ApprovalDecision {
  allowed: boolean;
  reason?: string;
}

export class ApprovalController {
  constructor(
    private mode: PermissionMode,
    private readonly confirm?: Confirmation,
  ) {}

  get permissionMode(): PermissionMode {
    return this.mode;
  }

  set permissionMode(mode: PermissionMode) {
    this.mode = mode;
  }

  async approve(toolName: string, args: unknown): Promise<ApprovalDecision> {
    if (toolName === "read_file" || toolName === "list_files" || toolName === "search_files") {
      return { allowed: true };
    }

    if (this.mode === "full") {
      return { allowed: true };
    }

    if (toolName === "run_command" || toolName === "exec_command") {
      const command =
        getStringProperty(args, "command") || getStringProperty(args, "cmd");
      const risk = classifyCommand(command);
      if (risk === "read-only") {
        return { allowed: true };
      }
      if (this.mode === "plan") {
        return { allowed: false, reason: "Permission mode is plan; mutating commands are disabled" };
      }
      return this.ask(
        risk === "dangerous"
          ? `Dangerous command requested:\n  ${command}\nRun it?`
          : `Command requested:\n  ${command}\nRun it?`,
      );
    }

    if (toolName === "write_file" || toolName === "edit_file" || toolName === "apply_patch") {
      if (this.mode === "plan") {
        return { allowed: false, reason: "Permission mode is plan; file changes are disabled" };
      }
      if (this.mode === "auto") {
        return { allowed: true };
      }
    }

    if (toolName === "write_file") {
      return this.ask(`Write file ${getStringProperty(args, "path")}?`);
    }

    if (toolName === "edit_file") {
      return this.ask(`Edit file ${getStringProperty(args, "path")}?`);
    }

    if (toolName === "apply_patch") {
      return this.ask("Apply the proposed workspace patch?");
    }

    return this.ask(`Allow tool ${toolName}?`);
  }

  private async ask(message: string): Promise<ApprovalDecision> {
    if (!this.confirm) {
      return {
        allowed: false,
        reason: "Interactive approval is unavailable. Re-run with --yes to auto-approve changes.",
      };
    }

    const allowed = await this.confirm(message);
    return allowed ? { allowed: true } : { allowed: false, reason: "Denied by user" };
  }
}

export type CommandRisk = "read-only" | "needs-approval" | "dangerous";

export function classifyCommand(command: string): CommandRisk {
  const normalized = command.trim();
  if (!normalized) {
    return "needs-approval";
  }

  if (
    /(^|\s)(rm|rmdir|sudo|doas|mkfs|shutdown|reboot|kill|pkill|killall)\b/i.test(normalized) ||
    /\bgit\s+(reset|clean)\b/i.test(normalized) ||
    /\bgit\s+(checkout|restore)\b[^;&|]*(--|\s)\./i.test(normalized)
  ) {
    return "dangerous";
  }

  // Windows executes through PowerShell: route cmdlet-shaped commands to the
  // PowerShell read-only classifier instead of punishing them with the POSIX
  // shell-syntax bail below. The classifier is conservative - anything it
  // cannot prove read-only lands in the normal approval path.
  if (process.platform === "win32" && looksLikePowerShell(normalized)) {
    return isReadOnlyPowerShellCommand(normalized) ? "read-only" : "needs-approval";
  }

  // Shell syntax can turn an otherwise harmless-looking command into a write
  // or execute substitution, so only simple commands are auto-approved.
  if (/[;&|><`$()\n\r]/.test(normalized)) {
    return "needs-approval";
  }

  const words = normalized.split(/\s+/);
  const executable = words[0]?.replace(/^.*\//, "") ?? "";

  if (
    words.some(
      (word) =>
        word.startsWith("/") ||
        word.startsWith("~/") ||
        word === ".." ||
        word.startsWith("../") ||
        word.includes("/../"),
    )
  ) {
    return "needs-approval";
  }

  if (["pwd", "ls", "tree", "head", "tail", "wc", "file", "stat", "which", "type"].includes(executable)) {
    return "read-only";
  }

  if (["cat", "rg", "grep"].includes(executable)) {
    return words.some((word) => word === "--files-without-match") ? "needs-approval" : "read-only";
  }

  if (executable === "find") {
    return words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word))
      ? "needs-approval"
      : "read-only";
  }

  if (executable === "sed") {
    return words.some((word) => word === "-i" || word.startsWith("-i")) ? "needs-approval" : "read-only";
  }

  if (executable === "git") {
    const subcommand = words[1] ?? "";
    return ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "grep"].includes(subcommand)
      ? "read-only"
      : "needs-approval";
  }

  return "needs-approval";
}

function getStringProperty(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : "";
}
