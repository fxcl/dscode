import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { getDSCodeHome } from "./home.js";

export type WebSearchProvider = "auto" | "deepseek" | "perplexity" | "exa" | "google" | "search-mcp";

export interface WebSearchConfig {
  enabled: boolean;
  provider: WebSearchProvider;
  perplexityApiKey?: string;
  exaApiKey?: string;
  googleApiKey?: string;
  /** search-mcp only: explicit binary path. If unset, PATH lookup is used. */
  searchMcpPath?: string;
}

export interface WebSearchStatus {
  configPath: string;
  configExists: boolean;
  enabled: boolean;
  provider: WebSearchProvider;
  perplexityConfigured: boolean;
  exaConfigured: boolean;
  googleConfigured: boolean;
  searchMcpConfigured: boolean;
}

const DEFAULT_CONFIG: WebSearchConfig = {
  enabled: false,
  provider: "deepseek",
};

export function getWebSearchConfigPath(): string {
  return path.join(getDSCodeHome(), "web-search.json");
}

function normalizeProvider(value: unknown): WebSearchProvider | undefined {
  return value === "auto" ||
    value === "deepseek" ||
    value === "perplexity" ||
    value === "exa" ||
    value === "google" ||
    value === "search-mcp"
    ? value
    : undefined;
}

export function loadWebSearchConfig(
  configPath = getWebSearchConfigPath(),
): WebSearchConfig {
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    return {
      enabled: parsed.enabled === true,
      provider: normalizeProvider(parsed.provider) ?? "deepseek",
      ...(typeof parsed.perplexityApiKey === "string" && parsed.perplexityApiKey.trim()
        ? { perplexityApiKey: parsed.perplexityApiKey.trim() }
        : {}),
      ...(typeof parsed.exaApiKey === "string" && parsed.exaApiKey.trim()
        ? { exaApiKey: parsed.exaApiKey.trim() }
        : {}),
      ...((typeof parsed.googleApiKey === "string" && parsed.googleApiKey.trim())
        ? { googleApiKey: parsed.googleApiKey.trim() }
        : ((typeof parsed.geminiApiKey === "string" && parsed.geminiApiKey.trim())
          ? { googleApiKey: parsed.geminiApiKey.trim() }
          : {})),
      ...(typeof parsed.searchMcpPath === "string" && parsed.searchMcpPath.trim()
        ? { searchMcpPath: parsed.searchMcpPath.trim() }
        : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveWebSearchConfig(
  updates: Partial<WebSearchConfig>,
  configPath = getWebSearchConfigPath(),
): void {
  const current = loadWebSearchConfig(configPath);
  const merged: WebSearchConfig = { ...current, ...updates };
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // best-effort permission hardening
  }
}

export function getWebSearchStatus(
  configPath = getWebSearchConfigPath(),
): WebSearchStatus {
  const config = loadWebSearchConfig(configPath);
  return {
    configPath,
    configExists: existsSync(configPath),
    enabled: config.enabled,
    provider: config.provider,
    perplexityConfigured: Boolean(config.perplexityApiKey),
    exaConfigured: Boolean(config.exaApiKey),
    googleConfigured: Boolean(config.googleApiKey),
    searchMcpConfigured: resolveSearchMcpBinary(config.searchMcpPath) !== undefined,
  };
}

/**
 * Resolve the active client-side web search execution target.
 *
 * Returns the provider + API key only when a non-DeepSeek provider is selected
 * AND its API key is configured. DeepSeek is handled server-side (see
 * optimizeDeepSeekResponsesPayload), so it never reaches this path.
 *
 * For search-mcp the `apiKey` field carries the resolved binary path instead.
 */
export interface ResolvedWebSearchExecution {
  provider: "exa" | "perplexity" | "google" | "search-mcp";
  apiKey: string;
}

export function resolveWebSearchExecution(
  configPath = getWebSearchConfigPath(),
): ResolvedWebSearchExecution | undefined {
  const config = loadWebSearchConfig(configPath);

  if (config.provider === "auto") {
    if (config.exaApiKey) return { provider: "exa", apiKey: config.exaApiKey };
    if (config.perplexityApiKey) return { provider: "perplexity", apiKey: config.perplexityApiKey };
    if (config.googleApiKey) return { provider: "google", apiKey: config.googleApiKey };
    const mcpBinary = resolveSearchMcpBinary(config.searchMcpPath);
    if (mcpBinary) return { provider: "search-mcp", apiKey: mcpBinary };
    return undefined;
  }

  if (config.provider === "perplexity" && config.perplexityApiKey) {
    return { provider: "perplexity", apiKey: config.perplexityApiKey };
  }
  if (config.provider === "exa" && config.exaApiKey) {
    return { provider: "exa", apiKey: config.exaApiKey };
  }
  if (config.provider === "google" && config.googleApiKey) {
    return { provider: "google", apiKey: config.googleApiKey };
  }
  if (config.provider === "search-mcp") {
    const mcpBinary = resolveSearchMcpBinary(config.searchMcpPath);
    if (mcpBinary) return { provider: "search-mcp", apiKey: mcpBinary };
    return undefined;
  }
  return undefined;
}

/**
 * Resolve the search-mcp binary path.
 *
 * Priority: explicit config → PATH lookup → common install locations.
 * Returns undefined if the binary cannot be found.
 */
export function resolveSearchMcpBinary(configuredPath?: string): string | undefined {
  // 1. Explicit path from config
  if (configuredPath && configuredPath.trim() && existsSync(configuredPath.trim())) {
    return configuredPath.trim();
  }

  // 2. PATH lookup
  try {
    const result = execFileSync("which", ["search-mcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    const resolved = result.trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // not on PATH
  }

  // 3. Common install locations
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "search-mcp"),
    path.join(home, "go", "bin", "search-mcp"),
    "/usr/local/bin/search-mcp",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

export function formatWebSearchStatus(status: WebSearchStatus): string {
  const resolved = resolveWebSearchExecution(status.configPath);
  const effectiveProvider = status.provider === "auto"
    ? (resolved ? resolved.provider : "deepseek (server-side)")
    : status.provider;

  const lines = [
    `web search  ${status.enabled ? "enabled" : "disabled"}`,
    `provider    ${status.provider} (effective: ${effectiveProvider})`,
  ];
  if (status.provider === "perplexity" || status.provider === "auto" || status.perplexityConfigured) {
    lines.push(`perplexity   ${status.perplexityConfigured ? "configured" : "no API key"}`);
  }
  if (status.provider === "exa" || status.provider === "auto" || status.exaConfigured) {
    lines.push(`exa          ${status.exaConfigured ? "configured" : "no API key"}`);
  }
  if (status.provider === "google" || status.provider === "auto" || status.googleConfigured) {
    lines.push(`google       ${status.googleConfigured ? "configured" : "no API key"}`);
  }
  if (status.provider === "search-mcp" || status.provider === "auto" || status.searchMcpConfigured) {
    lines.push(`search-mcp   ${status.searchMcpConfigured ? "binary found" : "binary not found"}`);
  }
  lines.push(`config       ${status.configPath}`);
  return lines.join("\n");
}
