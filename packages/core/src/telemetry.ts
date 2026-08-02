import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { getDSCodeHome } from "./home.js";

const TELEMETRY_STATE_FILE = "telemetry.json";
const TELEMETRY_DISABLED_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const TELEMETRY_KEY_PATTERN = /^[A-Za-z0-9_$./-]+$/;

export type TelemetryPrimitive = string | number | boolean | null | undefined;
export type TelemetryProperties = Record<string, TelemetryPrimitive>;

export type TelemetryConfig = {
  enabled: boolean;
  distinctId: string;
  appVersion?: string | undefined;
  serviceName: string;
};

type TelemetryState = {
  anonymousId?: string;
};

export type TelemetryTransportCircuitBreaker = {
  tryStart(): boolean;
  completeSuccess(): void;
  completeFailure(error: unknown): void;
  isOpen(): boolean;
};

export function createTelemetryTransportCircuitBreaker(
  onFailure: (error: unknown) => void,
): TelemetryTransportCircuitBreaker {
  let circuitOpen = false;
  return {
    tryStart() {
      return !circuitOpen;
    },
    completeSuccess() {},
    completeFailure(error) {
      if (circuitOpen) return;
      circuitOpen = true;
      onFailure(error);
    },
    isOpen() {
      return circuitOpen;
    },
  };
}

function successfulTelemetryDropResponse(): Response {
  return new Response(null, { status: 204 });
}

export function createCircuitBreakerFetch(
  fetchImpl: typeof fetch,
  onFailure: (error: unknown) => void,
  circuit = createTelemetryTransportCircuitBreaker(onFailure),
): typeof fetch {
  return async (url, options) => {
    if (!circuit.tryStart()) {
      return successfulTelemetryDropResponse();
    }

    try {
      const response = await fetchImpl(url, options);
      if (response.status >= 200 && response.status < 400) {
        circuit.completeSuccess();
        return response;
      }

      circuit.completeFailure(new Error(`Telemetry transport returned HTTP ${response.status}`));
      return successfulTelemetryDropResponse();
    } catch (error) {
      circuit.completeFailure(error);
      return successfulTelemetryDropResponse();
    }
  };
}

function isTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.DSCODE_TELEMETRY;
  return (
    (setting !== undefined && TELEMETRY_DISABLED_VALUES.has(setting.trim().toLowerCase())) ||
    env.DO_NOT_TRACK === "1"
  );
}

function readTelemetryState(path: string): TelemetryState {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TelemetryState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getAnonymousDistinctId(home = getDSCodeHome()): string {
  const stateDir = resolve(home, ".state");
  const statePath = resolve(stateDir, TELEMETRY_STATE_FILE);
  const state = readTelemetryState(statePath);
  if (typeof state.anonymousId === "string" && state.anonymousId.startsWith("dscode_")) {
    return state.anonymousId;
  }

  const anonymousId = `dscode_${randomUUID()}`;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ ...state, anonymousId }, null, 2) + "\n", "utf8");
  return anonymousId;
}

export function resolveTelemetryConfig(options?: {
  appVersion?: string;
  serviceName?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): TelemetryConfig | undefined {
  const env = options?.env ?? process.env;
  if (isTelemetryDisabled(env)) return undefined;

  return {
    enabled: true,
    distinctId: env.DSCODE_TELEMETRY_DISTINCT_ID?.trim() || getAnonymousDistinctId(options?.home),
    appVersion: options?.appVersion,
    serviceName: options?.serviceName ?? "dscode",
  };
}

function normalizeTelemetryKey(key: string): string | undefined {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_$./-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!normalized || !TELEMETRY_KEY_PATTERN.test(normalized)) return undefined;
  return normalized.slice(0, 80);
}

function normalizeTelemetryValue(
  value: TelemetryPrimitive,
): string | number | boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

export function normalizeTelemetryProperties(
  properties: TelemetryProperties = {},
): Record<string, string | number | boolean | null> {
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(properties)) {
    const normalizedKey = normalizeTelemetryKey(key);
    const normalizedValue = normalizeTelemetryValue(value);
    if (!normalizedKey || normalizedValue === undefined) continue;
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

export function stableTelemetryHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function telemetryErrorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : "Error";
}

export function telemetryErrorProperties(error: unknown): TelemetryProperties {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error_name: telemetryErrorName(error),
    error_message_hash: stableTelemetryHash(message),
  };
}

export function sanitizeTelemetryException(error: unknown): { name: string; message: string } {
  const properties = telemetryErrorProperties(error);
  return {
    name: String(properties.error_name ?? "unknown"),
    message: `error_message_hash:${properties.error_message_hash ?? "unknown"}`,
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === flag) return args[index + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function safeIntegerFlagValue(args: string[], flag: string): number | undefined {
  const value = flagValue(args, flag);
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

function safeEnumFlagValue<T extends string>(
  args: string[],
  flag: string,
  allowed: readonly T[],
): T | undefined {
  const value = flagValue(args, flag);
  if (value === undefined) return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

const FLAGS_WITH_VALUES = new Set([
  "--cwd",
  "--mode",
  "--model",
  "--limit",
  "--expand-citations",
  "--full-text-top",
  "--critique-top",
  "--synthesis-top",
  "--synthesis-model",
  "--output-dir",
  "--preference-file",
  "--reproduction-notes",
  "--prompt",
  "--service-tier",
  "--session-dir",
  "--source-fixture",
  "--tier1-threshold",
  "--tier2-threshold",
  "--thinking",
  "--overlap",
  "--window-size",
]);

function positionalArgs(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("--")) {
      const [flag] = arg.split("=", 1);
      if (!arg.includes("=") && FLAGS_WITH_VALUES.has(flag!)) index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  return positionals;
}

const DEFAULT_COMMAND_NAMES = new Set([
  "alpha",
  "chat",
  "doctor",
  "help",
  "model",
  "packages",
  "paper",
  "rank",
  "search",
  "setup",
  "status",
  "update",
]);

const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  alpha: new Set(["login", "logout", "status", "search", "get", "ask", "code", "annotate"]),
  model: new Set(["list", "login", "logout", "set", "tier"]),
  packages: new Set(["list", "install", "update"]),
  search: new Set(["status", "set", "clear"]),
  setup: new Set(["preview"]),
};

function resolveTelemetryCommand(
  args: string[],
  positionals: string[],
  knownCommands: ReadonlySet<string>,
): string {
  const first = positionals[0];
  if (first && knownCommands.has(first)) return first;
  if (hasFlag(args, "--version")) return "version";
  if (hasFlag(args, "--help")) return "help";
  if (hasFlag(args, "--doctor")) return "doctor";
  return "chat";
}

export function getCliTelemetryMetadata(
  args: string[],
  options: { knownCommands?: Iterable<string> } = {},
): Record<string, string | number | boolean | null> {
  const positionals = positionalArgs(args);
  const knownCommands = new Set([...DEFAULT_COMMAND_NAMES, ...(options.knownCommands ?? [])]);
  const command = resolveTelemetryCommand(args, positionals, knownCommands);
  const subcommand =
    positionals[1] && SAFE_SUBCOMMANDS[command]?.has(positionals[1]) ? positionals[1] : undefined;
  const isRankCommand = command === "rank";

  return normalizeTelemetryProperties({
    command,
    subcommand,
    mode: safeEnumFlagValue(args, "--mode", ["text", "json", "rpc"]),
    has_prompt: Boolean(flagValue(args, "--prompt")),
    has_model_override: Boolean(flagValue(args, "--model")),
    has_service_tier_override: Boolean(flagValue(args, "--service-tier")),
    new_session: hasFlag(args, "--new-session"),
    json: hasFlag(args, "--json"),
    synthesize: isRankCommand ? hasFlag(args, "--synthesize") : undefined,
    source_fixture: Boolean(flagValue(args, "--source-fixture")),
    preference_file: Boolean(flagValue(args, "--preference-file")),
    reproduction_notes: Boolean(flagValue(args, "--reproduction-notes")),
    rank_topic_provided: isRankCommand && positionals.length > 1,
    rank_limit: isRankCommand ? safeIntegerFlagValue(args, "--limit") : undefined,
    rank_expand_citations: isRankCommand ? safeIntegerFlagValue(args, "--expand-citations") : undefined,
    rank_full_text_top: isRankCommand ? safeIntegerFlagValue(args, "--full-text-top") : undefined,
    rank_critique_top: isRankCommand ? safeIntegerFlagValue(args, "--critique-top") : undefined,
    rank_synthesis_top: isRankCommand ? safeIntegerFlagValue(args, "--synthesis-top") : undefined,
  });
}
