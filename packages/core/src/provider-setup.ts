import { existsSync, readFileSync } from "node:fs";
import { exec as execCallback } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { promptChoice, promptSelect, promptText, type PromptSelectOption } from "./setup-prompts.js";
import { printInfo, printSection, printSuccess, printWarning } from "./terminal-ui.js";
import {
  getModelsJsonPath,
  upsertProviderBaseUrl,
  upsertProviderConfig,
} from "./models-json.js";
import { saveProviderApiKey } from "./auth.js";

const exec = promisify(execCallback);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CustomProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface CustomProviderSetup {
  providerId: string;
  modelIds: string[];
  baseUrl: string;
  api: CustomProviderApi;
  /** literal secret, env var name, or `!command` to resolve the API key at runtime */
  apiKeyConfig: string;
  /**
   * If true, add `Authorization: Bearer <apiKey>` to requests in addition to
   * whatever the API mode uses (useful for proxies that implement /v1/messages
   * but expect Bearer auth instead of x-api-key).
   */
  authHeader: boolean;
}

type ApiKeyProviderInfo = {
  id: string;
  label: string;
  envVar?: string;
};

const CUSTOM_PROVIDER_ENTRIES: ApiKeyProviderInfo[] = [
  { id: "lm-studio", label: "LM Studio (local OpenAI-compatible server)" },
  { id: "litellm", label: "LiteLLM Proxy (OpenAI-compatible gateway)" },
  { id: "__custom__", label: "Custom provider (local/self-hosted/proxy)" },
  { id: "amazon-bedrock", label: "Amazon Bedrock (AWS credential chain)" },
];

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function normalizeModelIds(value: string): string[] {
  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(items));
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeCustomProviderBaseUrl(
  api: CustomProviderApi,
  baseUrl: string,
): { baseUrl: string; note?: string } {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return { baseUrl: normalized };
  }

  // Pi expects Anthropic baseUrl without `/v1` (it appends `/v1/messages` internally).
  if (api === "anthropic-messages" && /\/v1$/i.test(normalized)) {
    return { baseUrl: normalized.replace(/\/v1$/i, ""), note: "Stripped trailing /v1 for Anthropic mode." };
  }

  return { baseUrl: normalized };
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(baseUrl);
}

const LOCAL_PROVIDER_IDS = new Set(["ollama", "lm-studio", "vllm", "llama-cpp", "llamacpp"]);

export function isLocalModelProvider(providerId: string, agentDir?: string): boolean {
  if (!providerId) {
    return false;
  }
  if (LOCAL_PROVIDER_IDS.has(providerId)) {
    return true;
  }

  try {
    const modelsJsonPath = getModelsJsonPath(agentDir);
    const raw = readFileSync(modelsJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, { baseUrl?: unknown }> };
    const provider = parsed.providers?.[providerId];
    return typeof provider?.baseUrl === "string" && isLocalBaseUrl(provider.baseUrl);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

export async function resolveApiKeyConfig(apiKeyConfig: string): Promise<string | undefined> {
  const trimmed = apiKeyConfig.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("!")) {
    const command = trimmed.slice(1).trim();
    if (!command) return undefined;
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
    try {
      const { stdout } = await exec(command, { shell, maxBuffer: 1024 * 1024 });
      const value = stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  const envValue = process.env[trimmed];
  if (typeof envValue === "string" && envValue.trim()) {
    return envValue.trim();
  }

  // Fall back to literal value.
  return trimmed;
}

// ---------------------------------------------------------------------------
// Model auto-discovery
// ---------------------------------------------------------------------------

export async function bestEffortFetchOpenAiModelIds(
  baseUrl: string,
  apiKey: string,
  authHeader: boolean,
): Promise<string[] | undefined> {
  const url = `${baseUrl}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "GET",
      ...(authHeader ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const json = (await response.json()) as unknown;
    if (!Array.isArray((json as { data?: unknown })?.data)) return undefined;
    return (json as { data: Array<{ id?: unknown }> }).data
      .map((entry) => (typeof entry.id === "string" ? entry.id : undefined))
      .filter((id): id is string => Boolean(id));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Interactive setup wizards
// ---------------------------------------------------------------------------

async function promptCustomProviderSetup(): Promise<CustomProviderSetup | undefined> {
  printSection("Custom Provider");
  const providerIdInput = await promptText("Provider id (e.g. my-proxy)", "custom");
  const providerId = normalizeProviderId(providerIdInput);
  if (!providerId || providerId === "__custom__") {
    printWarning("Invalid provider id.");
    return undefined;
  }

  const apiChoices = [
    "openai-completions — OpenAI Chat Completions compatible (e.g. /v1/chat/completions)",
    "openai-responses — OpenAI Responses compatible (e.g. /v1/responses)",
    "anthropic-messages — Anthropic Messages compatible (e.g. /v1/messages)",
    "google-generative-ai — Google Generative AI compatible (generativelanguage.googleapis.com)",
    "Cancel",
  ];
  const apiSelection = await promptChoice("API mode:", apiChoices, 0);
  if (apiSelection >= 4) {
    return undefined;
  }
  const apiModes: CustomProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
  const api = apiModes[apiSelection]!;

  const baseUrlDefault = ((): string => {
    if (api === "openai-completions" || api === "openai-responses") return "http://localhost:11434/v1";
    if (api === "anthropic-messages") return "https://api.anthropic.com";
    if (api === "google-generative-ai") return "https://generativelanguage.googleapis.com";
    return "http://localhost:11434/v1";
  })();
  const baseUrlPrompt =
    api === "openai-completions" || api === "openai-responses"
      ? "Base URL (include /v1 for OpenAI-compatible endpoints)"
      : api === "anthropic-messages"
        ? "Base URL (no trailing /, no /v1)"
        : "Base URL (no trailing /)";
  const baseUrlRaw = await promptText(baseUrlPrompt, baseUrlDefault);
  const { baseUrl, note: baseUrlNote } = normalizeCustomProviderBaseUrl(api, baseUrlRaw);
  if (!baseUrl) {
    printWarning("Base URL is required.");
    return undefined;
  }
  if (baseUrlNote) {
    printInfo(baseUrlNote);
  }

  let authHeader = false;
  if (api === "openai-completions" || api === "openai-responses") {
    const defaultAuthHeader = !isLocalBaseUrl(baseUrl);
    const authHeaderChoices = [
      "Yes (send Authorization: Bearer <apiKey>)",
      "No (common for local Ollama/vLLM/LM Studio)",
      "Cancel",
    ];
    const authHeaderSelection = await promptChoice(
      "Send Authorization header?",
      authHeaderChoices,
      defaultAuthHeader ? 0 : 1,
    );
    if (authHeaderSelection >= 2) {
      return undefined;
    }
    authHeader = authHeaderSelection === 0;
  }
  if (api === "anthropic-messages") {
    const defaultAuthHeader = isLocalBaseUrl(baseUrl);
    const authHeaderChoices = [
      "Yes (also send Authorization: Bearer <apiKey>)",
      "No (standard Anthropic uses x-api-key only)",
      "Cancel",
    ];
    const authHeaderSelection = await promptChoice(
      "Also send Authorization header?",
      authHeaderChoices,
      defaultAuthHeader ? 0 : 1,
    );
    if (authHeaderSelection >= 2) {
      return undefined;
    }
    authHeader = authHeaderSelection === 0;
  }

  printInfo("API key value supports:");
  printInfo("  - literal secret (stored in models.json)");
  printInfo("  - env var name (resolved at runtime)");
  printInfo("  - !command (executes and uses stdout)");
  const apiKeyConfigRaw = (await promptText("API key / resolver", "")).trim();
  const apiKeyConfig = apiKeyConfigRaw || "local";
  if (!apiKeyConfigRaw) {
    printInfo("Using placeholder apiKey value (required by Pi for custom providers).");
  }

  let modelIdsDefault = "my-model";
  if (api === "openai-completions" || api === "openai-responses") {
    // Best-effort: hit /models so users can pick correct ids (especially for proxies).
    const resolvedKey = await resolveApiKeyConfig(apiKeyConfig);
    const modelIds = resolvedKey ? await bestEffortFetchOpenAiModelIds(baseUrl, resolvedKey, authHeader) : undefined;
    if (modelIds && modelIds.length > 0) {
      const sample = modelIds.slice(0, 10).join(", ");
      printInfo(`Detected models: ${sample}${modelIds.length > 10 ? ", ..." : ""}`);
      modelIdsDefault = modelIds.includes("sonnet") ? "sonnet" : modelIds[0]!;
    }
  }

  const modelIdsRaw = await promptText("Model id(s) (comma-separated)", modelIdsDefault);
  const modelIds = normalizeModelIds(modelIdsRaw);
  if (modelIds.length === 0) {
    printWarning("At least one model id is required.");
    return undefined;
  }

  return { providerId, modelIds, baseUrl, api, apiKeyConfig, authHeader };
}

async function promptLmStudioProviderSetup(): Promise<CustomProviderSetup | undefined> {
  printSection("LM Studio");
  printInfo("Start the LM Studio local server first, then load a model.");

  const baseUrlRaw = await promptText("Base URL", "http://localhost:1234/v1");
  const { baseUrl } = normalizeCustomProviderBaseUrl("openai-completions", baseUrlRaw);
  if (!baseUrl) {
    printWarning("Base URL is required.");
    return undefined;
  }

  const detectedModelIds = await bestEffortFetchOpenAiModelIds(baseUrl, "lm-studio", false);
  let modelIdsDefault = "local-model";
  if (detectedModelIds && detectedModelIds.length > 0) {
    const sample = detectedModelIds.slice(0, 10).join(", ");
    printInfo(`Detected LM Studio models: ${sample}${detectedModelIds.length > 10 ? ", ..." : ""}`);
    modelIdsDefault = detectedModelIds[0]!;
  } else {
    printInfo("No models detected from /models. Enter the exact model id shown in LM Studio.");
  }

  const modelIdsRaw = await promptText("Model id(s) (comma-separated)", modelIdsDefault);
  const modelIds = normalizeModelIds(modelIdsRaw);
  if (modelIds.length === 0) {
    printWarning("At least one model id is required.");
    return undefined;
  }

  return {
    providerId: "lm-studio",
    modelIds,
    baseUrl,
    api: "openai-completions",
    apiKeyConfig: "lm-studio",
    authHeader: false,
  };
}

async function promptLiteLlmProviderSetup(): Promise<CustomProviderSetup | undefined> {
  printSection("LiteLLM Proxy");
  printInfo("Start the LiteLLM proxy first. DSCode uses the OpenAI-compatible chat-completions API.");

  const baseUrlRaw = await promptText("Base URL", "http://localhost:4000/v1");
  const { baseUrl } = normalizeCustomProviderBaseUrl("openai-completions", baseUrlRaw);
  if (!baseUrl) {
    printWarning("Base URL is required.");
    return undefined;
  }

  const keyChoices = [
    "Yes (use LITELLM_MASTER_KEY and send Authorization: Bearer <key>)",
    "No (proxy runs without authentication)",
    "Cancel",
  ];
  const keySelection = await promptChoice("Is the proxy protected by a master key?", keyChoices, 0);
  if (keySelection >= 2) {
    return undefined;
  }

  const hasKey = keySelection === 0;
  const apiKeyConfig = hasKey ? "LITELLM_MASTER_KEY" : "local";
  const authHeader = hasKey;
  if (hasKey) {
    printInfo("Set LITELLM_MASTER_KEY in your shell or .env before using DSCode.");
  }

  const resolvedKey = hasKey ? await resolveApiKeyConfig(apiKeyConfig) : apiKeyConfig;
  const detectedModelIds = resolvedKey
    ? await bestEffortFetchOpenAiModelIds(baseUrl, resolvedKey, authHeader)
    : undefined;

  let modelIdsDefault = "gpt-4";
  if (detectedModelIds && detectedModelIds.length > 0) {
    const sample = detectedModelIds.slice(0, 10).join(", ");
    printInfo(`Detected LiteLLM models: ${sample}${detectedModelIds.length > 10 ? ", ..." : ""}`);
    modelIdsDefault = detectedModelIds[0]!;
  } else {
    printInfo("No models detected from /models. Enter the model id(s) from your LiteLLM config.");
  }

  const modelIdsRaw = await promptText("Model id(s) (comma-separated)", modelIdsDefault);
  const modelIds = normalizeModelIds(modelIdsRaw);
  if (modelIds.length === 0) {
    printWarning("At least one model id is required.");
    return undefined;
  }

  return {
    providerId: "litellm",
    modelIds,
    baseUrl,
    api: "openai-completions",
    apiKeyConfig,
    authHeader,
  };
}

// ---------------------------------------------------------------------------
// Provider verification
// ---------------------------------------------------------------------------

export async function verifyCustomProvider(setup: CustomProviderSetup): Promise<void> {
  const timeoutMs = 8000;

  // Best-effort network check for OpenAI-compatible endpoints
  if (setup.api === "openai-completions" || setup.api === "openai-responses") {
    const resolvedKey = await resolveApiKeyConfig(setup.apiKeyConfig);
    const apiKey = resolvedKey ?? setup.apiKeyConfig;
    const url = `${setup.baseUrl}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        ...(setup.authHeader ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        printWarning(`Verification: ${url} returned ${response.status} ${response.statusText}`);
        return;
      }
      const json = (await response.json()) as unknown;
      const modelIds = Array.isArray((json as { data?: unknown })?.data)
        ? (json as { data: Array<{ id?: unknown }> }).data
            .map((entry) => (typeof entry.id === "string" ? entry.id : undefined))
            .filter((id): id is string => Boolean(id))
        : [];
      const missing = setup.modelIds.filter((id) => modelIds.length > 0 && !modelIds.includes(id));
      if (modelIds.length > 0 && missing.length > 0) {
        printWarning(`Verification: /models does not list configured model id(s): ${missing.join(", ")}`);
        return;
      }
      printSuccess("Verification: endpoint reachable and authorized.");
    } catch (error) {
      printWarning(`Verification: failed to reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (setup.api === "anthropic-messages") {
    const resolvedKey = await resolveApiKeyConfig(setup.apiKeyConfig);
    const apiKey = resolvedKey ?? setup.apiKeyConfig;
    const url = `${setup.baseUrl}/v1/models?limit=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      if (setup.authHeader) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        printWarning(`Verification: ${url} returned ${response.status} ${response.statusText}`);
        if (response.status === 404) {
          printInfo("  Tip: For Anthropic mode, use a base URL without /v1 (e.g. https://api.anthropic.com).");
        }
        if ((response.status === 401 || response.status === 403) && !setup.authHeader) {
          printInfo("  Tip: Some proxies require `Authorization: Bearer <apiKey>` even in Anthropic mode.");
        }
        return;
      }
      printSuccess("Verification: endpoint reachable and authorized.");
    } catch (error) {
      printWarning(`Verification: failed to reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (setup.api === "google-generative-ai") {
    const resolvedKey = await resolveApiKeyConfig(setup.apiKeyConfig);
    const apiKey = resolvedKey ?? setup.apiKeyConfig;
    // Send the API key via the x-goog-api-key header instead of a query
    // parameter so it never appears in the URL (and thus never in error
    // messages or logs).
    const safeUrl = `${setup.baseUrl}/v1beta/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(safeUrl, {
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
        signal: controller.signal,
      });
      if (!response.ok) {
        printWarning(`Verification: ${safeUrl} returned ${response.status} ${response.statusText}`);
        return;
      }
      printSuccess("Verification: endpoint reachable and authorized.");
    } catch (error) {
      printWarning(`Verification: failed to reach ${safeUrl}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  printInfo("Verification: skipped network probe for this API mode.");
}

// ---------------------------------------------------------------------------
// Bedrock credential verification
// ---------------------------------------------------------------------------

export async function configureBedrockProvider(): Promise<boolean> {
  printSection("AWS Credentials: Amazon Bedrock");
  printInfo("DSCode will check for AWS credentials used by Pi's Bedrock provider.");
  printInfo("Supported sources: AWS_PROFILE, ~/.aws credentials/config, SSO, ECS/IRSA, EC2 instance roles.");

  const hasEnvCredentials = Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
  );
  const profileName = process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE;
  const hasProfile = Boolean(profileName);

  let hasSharedCredentials = false;
  try {
    const awsDir = join(homedir(), ".aws");
    hasSharedCredentials =
      existsSync(join(awsDir, "credentials")) || existsSync(join(awsDir, "config"));
  } catch {}

  // On EC2/ECS, credentials come from the instance metadata service.
  const hasIamRole = Boolean(
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
  );

  if (hasEnvCredentials || hasSharedCredentials || hasProfile || hasIamRole) {
    await saveProviderApiKey("amazon-bedrock", "<authenticated>");
    printSuccess("Found AWS credential sources and marked Amazon Bedrock as configured.");
    if (hasEnvCredentials) {
      printInfo("  Source: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY");
    } else if (hasProfile) {
      printInfo(`  Source: AWS_PROFILE (${profileName})`);
    } else if (hasSharedCredentials) {
      printInfo("  Source: ~/.aws/credentials or ~/.aws/config");
    } else {
      printInfo("  Source: ECS/IRSA role metadata");
    }
    printInfo("Use `dscode auth status` to see available Bedrock models.");
    return true;
  }

  printWarning("No AWS credential sources detected.");
  printInfo("Configure AWS credentials first, for example:");
  printInfo("  export AWS_PROFILE=default");
  printInfo("  # or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY");
  printInfo("  # or use an EC2/ECS/IRSA role with valid Bedrock access");
  return false;
}

// ---------------------------------------------------------------------------
// Provider configuration entry points
// ---------------------------------------------------------------------------

async function saveCustomProviderToModelsJson(setup: CustomProviderSetup): Promise<boolean> {
  const modelsJsonPath = getModelsJsonPath();
  const result = upsertProviderConfig(modelsJsonPath, setup.providerId, {
    baseUrl: setup.baseUrl,
    apiKey: setup.apiKeyConfig,
    api: setup.api,
    authHeader: setup.authHeader,
    models: setup.modelIds.map((id) => ({ id })),
  });
  if (!result.ok) {
    printWarning(result.error);
    return false;
  }
  return true;
}

/**
 * Configure a single custom/local provider.  When `providerId` is omitted the
 * user is prompted to select from LM Studio, LiteLLM, a fully custom provider,
 * or Amazon Bedrock.
 */
export async function configureCustomProvider(providerId?: string): Promise<boolean> {
  let entry: ApiKeyProviderInfo | undefined;

  if (providerId) {
    entry = CUSTOM_PROVIDER_ENTRIES.find((p) => p.id === providerId);
    if (!entry) {
      throw new Error(`Unknown custom provider: ${providerId}. Choose from: ${CUSTOM_PROVIDER_ENTRIES.map((p) => p.id).join(", ")}`);
    }
  } else {
    const options: PromptSelectOption<ApiKeyProviderInfo | "cancel">[] = CUSTOM_PROVIDER_ENTRIES.map((provider) => ({
      value: provider,
      label: provider.label,
    }));
    options.push({ value: "cancel", label: "Cancel" });
    const selection = await promptSelect("Choose a provider to configure:", options, CUSTOM_PROVIDER_ENTRIES[0]);
    if (selection === "cancel") {
      printInfo("Provider setup cancelled.");
      return false;
    }
    entry = selection;
  }

  if (entry.id === "amazon-bedrock") {
    return configureBedrockProvider();
  }

  let setup: CustomProviderSetup | undefined;
  if (entry.id === "lm-studio") {
    setup = await promptLmStudioProviderSetup();
  } else if (entry.id === "litellm") {
    setup = await promptLiteLlmProviderSetup();
  } else {
    setup = await promptCustomProviderSetup();
  }

  if (!setup) {
    printInfo(`${entry.label} setup cancelled.`);
    return false;
  }

  if (!(await saveCustomProviderToModelsJson(setup))) {
    return false;
  }

  printSuccess(`Saved custom provider: ${setup.providerId}`);
  await verifyCustomProvider(setup);
  return true;
}

/**
 * Add or update a base-URL override for any provider in models.json.
 * Useful for redirecting a built-in provider to a self-hosted proxy.
 */
export async function configureProviderBaseUrl(providerId: string, baseUrl: string): Promise<boolean> {
  const modelsJsonPath = getModelsJsonPath();
  const result = upsertProviderBaseUrl(modelsJsonPath, providerId, baseUrl);
  if (result.ok) {
    printSuccess(`Saved baseUrl override for ${providerId} in models.json.`);
    return true;
  }
  printWarning(result.error);
  return false;
}
