/**
 * Provider /models probing: hit a custom provider's model-listing endpoint
 * so the setup wizard can show the ids the endpoint actually serves (and
 * their context windows when the endpoint reports them), instead of the
 * user guessing model ids — the classic pain for proxies and gateways.
 *
 * Four API families, one shape:
 *   - openai-completions / openai-responses: GET {base}/models with an
 *     optional Authorization header; bodies may be {data:[...]}, {models:
 *     [...]}, or a bare array; OpenRouter-style top_provider limits and
 *     context_length/max_tokens fields are recognized;
 *   - anthropic-messages: GET {base}/v1/models with x-api-key +
 *     anthropic-version;
 *   - google-generative-ai: GET {base}/v1beta/models?key=...; token limits
 *     map onto context/max-output.
 *
 * Never throws: every failure resolves to ok:false with a human-readable
 * detail. Design follows the documented command-code probing mechanism;
 * all wording is original.
 */

export type ProviderApiFamily = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface ProbedModel {
  id: string;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
}

export interface ProbeResult {
  ok: boolean;
  models: ProbedModel[];
  detail?: string | undefined;
}

export interface ProbeInput {
  api: ProviderApiFamily;
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return undefined;
}

interface LooseRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract models from any of the tolerated list-response shapes. */
export function extractModels(body: unknown): ProbedModel[] {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : isRecord(body) && Array.isArray(body.models)
        ? body.models
        : undefined;
  if (list === undefined) return [];
  const byId = new Map<string, ProbedModel>();
  for (const entry of list) {
    if (typeof entry === "string") {
      if (!byId.has(entry)) byId.set(entry, { id: entry });
      continue;
    }
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" && entry.id
      ? entry.id
      : typeof entry.name === "string" && entry.name
        ? entry.name
        : undefined;
    if (!id) continue;
    if (byId.has(id)) continue;
    const record = entry as LooseRecord;
    const topProvider = isRecord(record.top_provider) ? record.top_provider : undefined;
    const contextWindow =
      asPositiveInt(record.context_length) ??
      asPositiveInt(record.context_window) ??
      asPositiveInt(record.inputTokenLimit) ??
      asPositiveInt(record.input_token_limit) ??
      asPositiveInt(topProvider?.context_length);
    const maxOutput =
      asPositiveInt(record.max_completion_tokens) ??
      asPositiveInt(record.max_output_tokens) ??
      asPositiveInt(record.maxOutput) ??
      asPositiveInt(record.outputTokenLimit) ??
      asPositiveInt(record.output_token_limit) ??
      asPositiveInt(topProvider?.max_completion_tokens);
    byId.set(id, {
      id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
    });
  }
  return [...byId.values()];
}

function buildRequest(api: ProviderApiFamily, baseUrl: string, apiKey: string | undefined): { url: string; headers: Record<string, string> } {
  const base = baseUrl.replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    return {
      url: `${base}/v1/models`,
      headers: {
        accept: "application/json",
        ...(apiKey ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {}),
      },
    };
  }
  if (api === "google-generative-ai") {
    return {
      url: `${base}/v1beta/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`,
      headers: { accept: "application/json" },
    };
  }
  return {
    url: `${base}/models`,
    headers: {
      accept: "application/json",
      // Send both header shapes: gateways disagree on which one they read.
      ...(apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
    },
  };
}

/** Probe one endpoint. Resolves ok:false (with detail) on any failure. */
export async function probeProviderModels(input: ProbeInput): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const { url, headers } = buildRequest(input.api, input.baseUrl, input.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, models: [], detail: `the endpoint answered ${response.status} on its model list` };
    }
    const models = extractModels(await response.json());
    if (models.length === 0) {
      return { ok: false, models: [], detail: "the endpoint listed no models" };
    }
    return { ok: true, models };
  } catch (error) {
    return {
      ok: false,
      models: [],
      detail:
        error instanceof Error && (error.name === "AbortError" || controller.signal.aborted)
          ? "no answer within the probe timeout"
          : "could not reach the endpoint",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One-line summary for setup output: ids plus window sizes when known. */
export function formatProbeSummary(models: ProbedModel[], maxShown = 10): string {
  const shown = models.slice(0, maxShown).map((model) =>
    model.contextWindow !== undefined
      ? `${model.id} (context ${Math.round(model.contextWindow / 1000)}k)`
      : model.id,
  );
  const suffix = models.length > maxShown ? `, ... +${models.length - maxShown} more` : "";
  return `${shown.join(", ")}${suffix}`;
}
