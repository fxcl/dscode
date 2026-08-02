import fs from "node:fs";
import path from "node:path";
import { getDSCodeHome } from "./home.js";

export const SUPPORTED_PROVIDER_IDS = [
  "deepseek",
  "openai-codex",
  "openai",
  "anthropic",
  "openrouter",
  "zai",
  "kimi-coding",
  "minimax",
  "xai",
  "google",
  "groq",
  "mistral",
  "cerebras",
  "amazon-bedrock",
] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

// Default model IDs must exist in the bundled pi-ai data files
// (`node_modules/@earendil-works/pi-ai/dist/providers/data/*.json`).
// Bare names like "llama-4-scout-17b-16e-instruct" (without the
// `meta-llama/` prefix) may resolve at runtime but fail to instantiate, so
// prefer the exact ID the runtime knows about. Note that a single provider can
// ship the same family across different APIs (e.g. xai exposes grok-4.5 via
// openai-responses and grok-4.3 via openai-completions).
const DEFAULT_MODELS: Record<SupportedProviderId, string> = {
  deepseek: "deepseek-v4-flash",
  "openai-codex": "gpt-5.6-sol",
  openai: "gpt-5.6-sol",
  anthropic: "claude-opus-4-8",
  openrouter: "moonshotai/kimi-k2.6",
  zai: "glm-5.1",
  "kimi-coding": "kimi-for-coding",
  minimax: "MiniMax-M2.7",
  xai: "grok-4.5",
  google: "gemini-2.5-flash",
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
  mistral: "mistral-large-latest",
  cerebras: "gpt-oss-120b",
  "amazon-bedrock": "anthropic.claude-opus-4-8",
};

const DEFAULT_EFFORTS: Record<SupportedProviderId, string> = {
  deepseek: "max",
  "openai-codex": "medium",
  openai: "medium",
  anthropic: "medium",
  openrouter: "medium",
  zai: "medium",
  "kimi-coding": "medium",
  minimax: "medium",
  xai: "medium",
  google: "medium",
  groq: "medium",
  mistral: "medium",
  cerebras: "medium",
  "amazon-bedrock": "medium",
};

const PROVIDER_NAMES: Record<SupportedProviderId, string> = {
  deepseek: "DeepSeek",
  "openai-codex": "OpenAI Codex (ChatGPT plan)",
  openai: "OpenAI API",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  zai: "Z.AI Coding Plan",
  "kimi-coding": "Kimi For Coding",
  minimax: "MiniMax",
  xai: "xAI (Grok)",
  google: "Google Gemini",
  groq: "Groq",
  mistral: "Mistral",
  cerebras: "Cerebras",
  "amazon-bedrock": "Amazon Bedrock",
};

const PROVIDER_ENVIRONMENT_KEYS: Partial<Record<SupportedProviderId, string>> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  xai: "XAI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
};

const PROVIDER_ALIASES: Readonly<Record<string, SupportedProviderId>> = {
  grok: "xai",
  kimi: "kimi-coding",
  gemini: "google",
};

export const MODEL_CREDENTIAL_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
] as const;

export interface StoredModelSelection {
  providerId: SupportedProviderId;
  modelId?: string;
}

export function isSupportedProviderId(value: string): value is SupportedProviderId {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

export function parseSupportedProviderId(value: string): SupportedProviderId {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  const providerId = PROVIDER_ALIASES[normalized] ?? normalized;
  if (isSupportedProviderId(providerId)) return providerId;
  throw new Error(
    `Unsupported provider "${value}". Choose ${SUPPORTED_PROVIDER_IDS.join(", ")}.`,
  );
}

export function defaultModelForProvider(providerId: SupportedProviderId): string {
  return DEFAULT_MODELS[providerId];
}

export function defaultEffortForProvider(providerId: SupportedProviderId): string {
  return DEFAULT_EFFORTS[providerId];
}

export function providerDisplayName(providerId: SupportedProviderId): string {
  return PROVIDER_NAMES[providerId];
}

export function providerEnvironmentKey(providerId: SupportedProviderId): string | undefined {
  return PROVIDER_ENVIRONMENT_KEYS[providerId];
}

export function getStoredModelSelection(
  settingsPath = path.join(getDSCodeHome(), "settings.json"),
): StoredModelSelection | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (typeof settings.defaultProvider !== "string") return undefined;
    const normalized = settings.defaultProvider.toLocaleLowerCase("en-US");
    if (!isSupportedProviderId(normalized)) return undefined;
    return {
      providerId: normalized,
      ...(typeof settings.defaultModel === "string" && settings.defaultModel.trim()
        ? { modelId: settings.defaultModel.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveModelSelection(
  providerId: SupportedProviderId,
  modelId?: string,
  settingsPath = path.join(getDSCodeHome(), "settings.json"),
): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    // start fresh if unreadable
  }
  settings.defaultProvider = providerId;
  if (modelId) {
    settings.defaultModel = modelId;
  } else {
    delete settings.defaultModel;
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function stripModelCredentialEnvironment<T extends Record<string, string | undefined>>(
  environment: T,
): T {
  for (const name of MODEL_CREDENTIAL_ENV_KEYS) delete environment[name];
  return environment;
}

// ---------------------------------------------------------------------------
// Model recommendation
// ---------------------------------------------------------------------------

export interface ModelPreference {
  providerId: SupportedProviderId;
  modelId: string;
  reason: string;
}

export interface ModelRecommendation {
  providerId: SupportedProviderId;
  modelId: string;
  reason: string;
}

const CODING_MODEL_PREFERENCES: ModelPreference[] = [
  { providerId: "anthropic", modelId: "claude-opus-4-8", reason: "strongest code generation and refactoring" },
  { providerId: "openai-codex", modelId: "gpt-5.6-sol", reason: "optimized for coding tasks with ChatGPT plan" },
  { providerId: "openai", modelId: "gpt-5.6-sol", reason: "strong general coding and reasoning" },
  { providerId: "xai", modelId: "grok-4.5", reason: "fast reasoning with competitive code quality" },
  { providerId: "deepseek", modelId: "deepseek-v4-flash", reason: "fast and cost-effective for iterative work" },
  { providerId: "openrouter", modelId: "moonshotai/kimi-k2.6", reason: "good routed fallback with broad model access" },
  { providerId: "kimi-coding", modelId: "kimi-for-coding", reason: "coding-specialized Kimi plan" },
  { providerId: "zai", modelId: "glm-5.1", reason: "solid fallback for GLM-based coding" },
  { providerId: "minimax", modelId: "MiniMax-M2.7", reason: "good fallback when MiniMax is the available provider" },
  { providerId: "groq", modelId: "meta-llama/llama-4-scout-17b-16e-instruct", reason: "extremely fast inference for rapid iterations" },
  { providerId: "mistral", modelId: "mistral-large-latest", reason: "solid alternative for robust reasoning" },
  { providerId: "cerebras", modelId: "gpt-oss-120b", reason: "high-throughput alternative for fast responses" },
  { providerId: "google", modelId: "gemini-2.5-flash", reason: "fast standard model for general coding" },
  { providerId: "amazon-bedrock", modelId: "anthropic.claude-opus-4-8", reason: "enterprise fallback leveraging AWS infrastructure" },
];

/** Detect which providers have credentials available (env key set). */
export function detectAvailableProviders(): SupportedProviderId[] {
  return SUPPORTED_PROVIDER_IDS.filter((id) => {
    const envKey = PROVIDER_ENVIRONMENT_KEYS[id];
    return envKey ? Boolean(process.env[envKey]?.trim()) : false;
  });
}

/** Choose the best model from available providers based on coding preferences. */
export function chooseRecommendedModel(
  availableProviders?: SupportedProviderId[],
): ModelRecommendation | undefined {
  const available = availableProviders ?? detectAvailableProviders();
  if (available.length === 0) return undefined;

  const availableSet = new Set(available);
  for (const preference of CODING_MODEL_PREFERENCES) {
    if (availableSet.has(preference.providerId)) {
      return {
        providerId: preference.providerId,
        modelId: preference.modelId,
        reason: preference.reason,
      };
    }
  }

  // Fall back to the first available provider with its default model.
  const first = available[0]!;
  return {
    providerId: first,
    modelId: DEFAULT_MODELS[first],
    reason: "best currently authenticated fallback for coding work",
  };
}

/** Build guidance hints about model configuration for status/doctor output. */
export function buildModelGuidance(
  current: StoredModelSelection | undefined,
  availableProviders?: SupportedProviderId[],
): string[] {
  const available = availableProviders ?? detectAvailableProviders();
  const guidance: string[] = [];

  if (available.length === 0) {
    guidance.push("No provider API keys detected in environment.");
    guidance.push("Run `dscode login <provider>` or set an API key env var.");
    return guidance;
  }

  const recommended = chooseRecommendedModel(available);
  if (!current && recommended) {
    guidance.push(
      `No default model stored. Recommended: ${recommended.providerId}/${recommended.modelId} (${recommended.reason}).`,
    );
    guidance.push("Run `dscode setup` or set DSCODE_PROVIDER/DSCODE_MODEL.");
  } else if (current && recommended && current.providerId !== recommended.providerId) {
    guidance.push(
      `Available recommendation: ${recommended.providerId}/${recommended.modelId} (${recommended.reason}).`,
    );
  }

  return guidance;
}
