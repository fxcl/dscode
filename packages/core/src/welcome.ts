import os from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { brandBlue } from "./brand.js";

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
  const capabilities = [
    details.toolCount !== undefined ? `${details.toolCount} tools` : null,
    details.commandCount !== undefined ? `${details.commandCount} commands` : null,
    details.mcpServers ? `${details.mcpServers} mcp` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const info = [
    `${theme.bold("DSCode")} ${theme.fg("muted", `v${details.version}`)}`,
    theme.fg(
      "muted",
      `${details.modelName ?? humanizeModel(details.modelId)} · ${details.effort} effort`,
    ),
    theme.fg("muted", formatCwd(details.cwd)),
    ...(capabilities ? [theme.fg("dim", capabilities)] : []),
  ];
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
