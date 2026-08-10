import os from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { brandBlue } from "./brand.js";
import type { PermissionMode } from "./config.js";

export interface WelcomeDetails {
  cwd: string;
  modelId: string;
  modelName?: string;
  effort: string;
  version: string;
  toolCount?: number;
  commandCount?: number;
  mcpServers?: number;
  serviceTier?: string;
  permission?: PermissionMode;
  sandbox?: string;
  network?: boolean;
  contextPercent?: number | null;
  sessionName?: string;
  branch?: string;
}

/** Terminal pixel-art rendering of DSCode's block-whale logo. */
export const DSCODE_LOGO = [
  "      ▀▄▀",
  "▄▄▄██████▄",
  " ███████ █",
  "█▀███████▀",
  "     ██",
];

export class DSCodeWelcomeHeader implements Component {
  constructor(
    private readonly details: WelcomeDetails,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    return renderWelcome(width, this.details, this.theme);
  }

  invalidate(): void {}
}

export function renderWelcome(width: number, details: WelcomeDetails, theme: Theme): string[] {
  if (width <= 0) return [];
  if (width < 18) {
    return [truncateToWidth(brandBlue(`DSCode v${details.version}`, theme), width, "")];
  }
  const padding = width >= 24 ? "  " : "";
  const gap = "   ";
  const logo = normalizeLogo(DSCODE_LOGO);

  const info: string[] = [
    `${theme.bold("DSCode")} ${theme.fg("muted", `v${details.version}`)}`,
    theme.fg(
      "muted",
      `${details.modelName ?? humanizeModel(details.modelId)} · ${details.effort} effort`,
    ),
    theme.fg("muted", formatCwdLabel(details)),
  ];

  const accessLine = formatAccessLine(details, theme);
  if (accessLine) info.push(accessLine);

  const capsLine = formatCapsLine(details, theme);
  if (capsLine) info.push(capsLine);

  if (details.serviceTier) {
    info.push(theme.fg("dim", `tier: ${details.serviceTier}`));
  }

  const sideBySideWidth = visibleWidth(padding) + visibleWidth(logo[0] ?? "") + gap.length + 12;
  if (width < sideBySideWidth) {
    return [
      ...logo.map((line) => truncateToWidth(`${padding}${brandBlue(line, theme)}`, width, "")),
      ...info.map((line) => truncateToWidth(`${padding}${line}`, width, theme.fg("dim", "…"))),
    ];
  }
  return logo.map((line, index) =>
    truncateToWidth(
      `${padding}${brandBlue(line, theme)}${index < info.length ? `${gap}${info[index]}` : ""}`,
      width,
      theme.fg("dim", "…"),
    ),
  );
}

function formatCwdLabel(details: WelcomeDetails): string {
  const cwdText = formatCwd(details.cwd);
  const branchText = details.branch ? ` (${details.branch})` : "";
  return `${cwdText}${branchText}`;
}

function formatAccessLine(
  details: WelcomeDetails,
  theme: Theme,
): string | undefined {
  if (details.permission === undefined) return undefined;
  const parts: string[] = [];

  if (details.permission === "plan") {
    parts.push(theme.fg("warning", "plan"));
  } else if (details.sandbox === "danger-full-access") {
    parts.push(theme.fg("error", "danger full access"));
  } else if (details.permission === "full") {
    parts.push(theme.fg("warning", "full permission"));
  } else {
    parts.push(theme.fg("dim", details.permission));
  }

  if (details.network && details.sandbox !== "danger-full-access") {
    parts.push(theme.fg("muted", "network"));
  }

  if (details.sessionName && details.sessionName !== "memory only") {
    parts.push(theme.fg("dim", details.sessionName));
  }

  return parts.length > 0 ? parts.join(theme.fg("dim", " · ")) : undefined;
}

function formatCapsLine(
  details: WelcomeDetails,
  theme: Theme,
): string | undefined {
  const parts: string[] = [];

  if (details.contextPercent !== undefined && details.contextPercent !== null) {
    const pct = details.contextPercent;
    const ctxStr = `ctx ${pct.toFixed(0)}%`;
    if (pct >= 90) {
      parts.push(theme.fg("error", ctxStr));
    } else if (pct >= 70) {
      parts.push(theme.fg("warning", ctxStr));
    } else {
      parts.push(theme.fg("dim", ctxStr));
    }
  }

  if (details.toolCount !== undefined) {
    parts.push(theme.fg("dim", `${details.toolCount} tools`));
  }
  if (details.commandCount !== undefined) {
    parts.push(theme.fg("dim", `${details.commandCount} cmds`));
  }
  if (details.mcpServers) {
    parts.push(theme.fg("dim", `${details.mcpServers} mcp`));
  }

  return parts.length > 0 ? parts.join(theme.fg("dim", " · ")) : undefined;
}

export function formatCwd(cwd: string): string {
  const homeDirectory = os.homedir();
  return cwd === homeDirectory || cwd.startsWith(`${homeDirectory}${path.sep}`)
    ? `~${cwd.slice(homeDirectory.length)}`
    : cwd;
}

function humanizeModel(modelId: string): string {
  if (modelId === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  return modelId;
}

function normalizeLogo(lines: string[]): string[] {
  const width = Math.max(...lines.map((line) => visibleWidth(line)));
  return lines.map((line) => `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`);
}
