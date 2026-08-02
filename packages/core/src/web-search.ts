import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDSCodeHome } from "./home.js";

export type WebSearchProvider = "auto" | "deepseek" | "perplexity" | "exa" | "google";

export interface WebSearchConfig {
  enabled: boolean;
  provider: WebSearchProvider;
  perplexityApiKey?: string;
  exaApiKey?: string;
  googleApiKey?: string;
}

export interface WebSearchStatus {
  configPath: string;
  configExists: boolean;
  enabled: boolean;
  provider: WebSearchProvider;
  perplexityConfigured: boolean;
  exaConfigured: boolean;
  googleConfigured: boolean;
}

const DEFAULT_CONFIG: WebSearchConfig = {
  enabled: false,
  provider: "deepseek",
};

export function getWebSearchConfigPath(): string {
  return path.join(getDSCodeHome(), "web-search.json");
}

function normalizeProvider(value: unknown): WebSearchProvider | undefined {
  return value === "auto" || value === "deepseek" || value === "perplexity" || value === "exa" || value === "google"
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
  };
}

/**
 * Resolve the active client-side web search execution target.
 *
 * Returns the provider + API key only when a non-DeepSeek provider is selected
 * AND its API key is configured. DeepSeek is handled server-side (see
 * optimizeDeepSeekResponsesPayload), so it never reaches this path.
 */
export interface ResolvedWebSearchExecution {
  provider: "exa" | "perplexity" | "google";
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
    lines.push(`perplexity  ${status.perplexityConfigured ? "configured" : "no API key"}`);
  }
  if (status.provider === "exa" || status.provider === "auto" || status.exaConfigured) {
    lines.push(`exa         ${status.exaConfigured ? "configured" : "no API key"}`);
  }
  if (status.provider === "google" || status.provider === "auto" || status.googleConfigured) {
    lines.push(`google      ${status.googleConfigured ? "configured" : "no API key"}`);
  }
  lines.push(`config      ${status.configPath}`);
  return lines.join("\n");
}
