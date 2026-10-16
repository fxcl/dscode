import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Competitor MCP migration: discover MCP server declarations left behind by
 * other coding tools and convert them to DSCode's `.dscode/mcp.json` shape,
 * so switching tools does not mean re-typing server configs. Four JSON-
 * based sources are supported:
 *
 *   - Claude Code: ~/.claude.json and <project>/.mcp.json (mcpServers;
 *     entries may carry a "type" of stdio/http/sse);
 *   - Cursor: ~/.cursor/mcp.json (mcpServers);
 *   - Gemini: ~/.gemini/settings.json (mcpServers);
 *   - OpenCode: ~/.config/opencode/opencode.json and project opencode.json
 *     (mcp; local entries carry command as an ARRAY, remote carry url).
 *
 * Codex uses TOML and is intentionally not parsed. Env values migrate
 * verbatim (including ${vault:} references if the user already used them);
 * plaintext secrets are the user's call to keep or trim after import.
 * Detection follows the documented command-code competitor mechanism in
 * scope; all wording is original.
 */

export type McpServerConfigShape =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> };

export interface DiscoveredMcpServer {
  source: "claude-code" | "cursor" | "gemini" | "opencode";
  name: string;
  config: McpServerConfigShape;
  /** Where the declaration was read from (diagnostics). */
  origin: string;
}

export interface DiscoveryReport {
  servers: DiscoveredMcpServer[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/** Convert one competitor entry; undefined when the shape is unusable. */
export function convertCompetitorEntry(entry: unknown): McpServerConfigShape | undefined {
  if (!isRecord(entry)) return undefined;
  // Remote shapes (url on any family) convert to DSCode's http form.
  if (typeof entry.url === "string" && entry.url) {
    const headers = stringRecord(entry.headers);
    return { url: entry.url, ...(headers ? { headers } : {}) };
  }
  // OpenCode carries the command as an array; everyone else as a string
  // plus an args field. Both normalize to command + optional args.
  let command: string;
  let rest: string[];
  if (typeof entry.command === "string" && entry.command) {
    command = entry.command;
    rest = Array.isArray(entry.args) && entry.args.every((part) => typeof part === "string") ? (entry.args as string[]) : [];
  } else if (Array.isArray(entry.command) && entry.command.length > 0 && entry.command.every((part) => typeof part === "string")) {
    command = entry.command[0] as string;
    rest = (entry.command as string[]).slice(1);
  } else {
    return undefined;
  }
  const env = stringRecord(entry.env);
  return {
    command,
    ...(rest.length > 0 ? { args: rest } : {}),
    ...(env ? { env } : {}),
    ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
  };
}

function collectFromServersMap(
  map: unknown,
  source: DiscoveredMcpServer["source"],
  origin: string,
  into: DiscoveredMcpServer[],
): void {
  if (!isRecord(map)) return;
  for (const [name, entry] of Object.entries(map)) {
    const config = convertCompetitorEntry(entry);
    if (config) into.push({ source, name, config, origin });
  }
}

/** Discover declarations from every supported source; all probes are best-effort. */
export async function discoverCompetitorMcpServers(home: string, projectRoot: string): Promise<DiscoveryReport> {
  const servers: DiscoveredMcpServer[] = [];
  const warnings: string[] = [];

  const claudeGlobal = await readJson(path.join(home, ".claude.json"));
  if (isRecord(claudeGlobal)) {
    collectFromServersMap(claudeGlobal.mcpServers, "claude-code", "~/.claude.json", servers);
  }
  const claudeProject = await readJson(path.join(projectRoot, ".mcp.json"));
  if (isRecord(claudeProject)) {
    collectFromServersMap(claudeProject.mcpServers, "claude-code", ".mcp.json", servers);
  }
  const cursor = await readJson(path.join(home, ".cursor", "mcp.json"));
  if (isRecord(cursor)) {
    collectFromServersMap(cursor.mcpServers, "cursor", "~/.cursor/mcp.json", servers);
  }
  const gemini = await readJson(path.join(home, ".gemini", "settings.json"));
  if (isRecord(gemini)) {
    collectFromServersMap(gemini.mcpServers, "gemini", "~/.gemini/settings.json", servers);
  }
  const opencodeGlobal = await readJson(path.join(home, ".config", "opencode", "opencode.json"));
  if (isRecord(opencodeGlobal)) {
    collectFromServersMap(opencodeGlobal.mcp, "opencode", "~/.config/opencode/opencode.json", servers);
  }
  const opencodeProject = await readJson(path.join(projectRoot, "opencode.json"));
  if (isRecord(opencodeProject)) {
    collectFromServersMap(opencodeProject.mcp, "opencode", "opencode.json", servers);
  }
  if (servers.length === 0) {
    warnings.push("No competitor MCP declarations found (checked Claude Code, Cursor, Gemini, OpenCode).");
  }
  return { servers, warnings };
}

export interface MergeOutcome {
  config: { mcpServers: Record<string, McpServerConfigShape> };
  added: Array<{ name: string; source: DiscoveredMcpServer["source"] }>;
  /** Same name, byte-identical config: nothing to do. */
  identical: string[];
  /** Same name, different config: the existing DSCode entry wins. */
  conflicts: Array<{ name: string; source: DiscoveredMcpServer["source"] }>;
}

/** Merge discoveries into an existing config; existing entries always win. */
export function mergeCompetitorServers(
  existing: { mcpServers: Record<string, McpServerConfigShape> },
  discoveries: readonly DiscoveredMcpServer[],
): MergeOutcome {
  const config: { mcpServers: Record<string, McpServerConfigShape> } = {
    mcpServers: { ...existing.mcpServers },
  };
  const added: MergeOutcome["added"] = [];
  const identical: string[] = [];
  const conflicts: MergeOutcome["conflicts"] = [];
  for (const found of discoveries) {
    const current = config.mcpServers[found.name];
    if (current === undefined) {
      config.mcpServers[found.name] = found.config;
      added.push({ name: found.name, source: found.source });
      continue;
    }
    if (JSON.stringify(current) === JSON.stringify(found.config)) {
      identical.push(found.name);
    } else {
      conflicts.push({ name: found.name, source: found.source });
    }
  }
  return { config, added, identical, conflicts };
}
