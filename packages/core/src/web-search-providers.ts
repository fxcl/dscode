/**
 * Web search execution layer for non-DeepSeek providers.
 *
 * DeepSeek performs web search server-side (see optimizeDeepSeekResponsesPayload).
 * Perplexity and Exa require an explicit client-side HTTP call, exposed to the
 * agent as a `web_search` tool. This module contains pure, testable functions —
 * no file system, no global state — so it can be unit tested with a mocked fetch.
 */

/** A single search hit, normalized across providers. */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

/** Normalized search response shared by every provider. */
export interface WebSearchResponse {
  provider: WebSearchExecProvider;
  query: string;
  hits: WebSearchHit[];
  /** Perplexity returns a synthesized answer; Exa does not. */
  answer?: string;
}

export type WebSearchExecProvider = "exa" | "perplexity" | "google";

export interface WebSearchExecOptions {
  /** Maximum number of results to request. Defaults to 5. */
  numResults?: number;
  /** Abort the request early. */
  signal?: AbortSignal;
}

const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Error thrown when a web search provider request fails. */
export class WebSearchError extends Error {
  readonly provider: WebSearchExecProvider;
  readonly status?: number | undefined;
  constructor(
    provider: WebSearchExecProvider,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "WebSearchError";
    this.provider = provider;
    this.status = status;
  }
}

function timeoutSignal(timeoutMs: number, existing?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // If the caller already supplied a signal, forward its abort.
  existing?.addEventListener("abort", () => controller.abort(), { once: true });
  // Clear the timer once the controller fires so the timer does not keep the process alive.
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new WebSearchError(
      // provider is filled in by the caller via the catch path; kept generic here.
      "exa",
      `Unexpected response body (status ${response.status})`,
      response.status,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Search the web with Exa (https://api.exa.ai/search).
 * Requires an API key obtained from the Exa dashboard.
 */
export async function searchWithExa(
  query: string,
  apiKey: string,
  options: WebSearchExecOptions = {},
): Promise<WebSearchResponse> {
  if (!apiKey.trim()) {
    throw new WebSearchError("exa", "Exa API key is missing");
  }
  const numResults = options.numResults ?? DEFAULT_NUM_RESULTS;
  let response: Response;
  try {
    response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        numResults,
        contents: { text: { maxCharacters: 1000 } },
      }),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS, options.signal),
    });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError("exa", `Network request failed: ${humanizeError(error)}`);
  }

  if (!response.ok) {
    throw new WebSearchError("exa", await describeErrorBody(response), response.status);
  }

  const payload = await readJson(response);
  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  const hits: WebSearchHit[] = results
    .filter(isRecord)
    .map((item): WebSearchHit => {
      const hit: WebSearchHit = {
        title: asString(item.title) ?? asString(item.url) ?? "Untitled",
        url: asString(item.url) ?? "",
        snippet: asString(item.text) ?? "",
      };
      const publishedDate = asString(item.publishedDate);
      if (publishedDate) hit.publishedDate = publishedDate;
      return hit;
    })
    .filter((hit) => hit.url.length > 0);

  return { provider: "exa", query, hits };
}

/**
 * Search the web with Perplexity's Sonar model (https://api.perplexity.ai/chat/completions).
 * Returns a synthesized answer plus cited URLs.
 */
export async function searchWithPerplexity(
  query: string,
  apiKey: string,
  options: WebSearchExecOptions = {},
): Promise<WebSearchResponse> {
  if (!apiKey.trim()) {
    throw new WebSearchError("perplexity", "Perplexity API key is missing");
  }
  const numResults = options.numResults ?? DEFAULT_NUM_RESULTS;
  let response: Response;
  try {
    response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: query }],
        return_citations: true,
        search_recency_filter: "auto",
      }),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS, options.signal),
    });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError("perplexity", `Network request failed: ${humanizeError(error)}`);
  }

  if (!response.ok) {
    throw new WebSearchError("perplexity", await describeErrorBody(response), response.status);
  }

  const payload = await readJson(response);
  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices.find(isRecord);
  const message = isRecord(firstChoice?.message) ? firstChoice.message : undefined;
  const answer = asString(message?.content);
  const citations = isRecord(payload) && Array.isArray(payload.citations) ? payload.citations : [];

  const hits: WebSearchHit[] = citations
    .map((citation): WebSearchHit => {
      const url = asString(citation) ?? "";
      return { title: url, url, snippet: "" };
    })
    .filter((hit) => hit.url.length > 0)
    .slice(0, numResults);

  return {
    provider: "perplexity",
    query,
    hits,
    ...(answer ? { answer } : {}),
  };
}

/**
 * Search the web with Google Generative Language API (Gemini with googleSearch grounding).
 */
export async function searchWithGoogle(
  query: string,
  apiKey: string,
  options: WebSearchExecOptions = {},
): Promise<WebSearchResponse> {
  if (!apiKey.trim()) {
    throw new WebSearchError("google", "Google API key is missing");
  }
  const numResults = options.numResults ?? DEFAULT_NUM_RESULTS;
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ googleSearch: {} }],
      }),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS, options.signal),
    });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError("google", `Network request failed: ${humanizeError(error)}`);
  }

  if (!response.ok) {
    throw new WebSearchError("google", await describeErrorBody(response), response.status);
  }

  const payload = await readJson(response) as any;
  const answer = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  
  const chunks = payload?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const webChunks = chunks.filter((c: any) => c.web?.uri && c.web?.title);
  
  const hits: WebSearchHit[] = webChunks.map((chunk: any) => ({
    title: chunk.web.title,
    url: chunk.web.uri,
    snippet: "",
  })).slice(0, numResults);
  
  return {
    provider: "google",
    query,
    hits,
    ...(answer ? { answer } : {}),
  };
}

/**
 * Run a search against the configured provider. DeepSeek is handled server-side
 * elsewhere, so only exa/perplexity reach this function.
 */
export async function executeWebSearch(
  provider: WebSearchExecProvider,
  query: string,
  apiKey: string,
  options?: WebSearchExecOptions,
): Promise<WebSearchResponse> {
  if (provider === "exa") return searchWithExa(query, apiKey, options);
  if (provider === "perplexity") return searchWithPerplexity(query, apiKey, options);
  return searchWithGoogle(query, apiKey, options);
}

/** Render a search response as Markdown for tool output or logging. */
export function formatWebSearchResponse(response: WebSearchResponse): string {
  const lines: string[] = [];
  if (response.answer) {
    lines.push(response.answer.trim(), "");
  }
  if (response.hits.length === 0) {
    lines.push("No results found.");
    return lines.join("\n");
  }
  for (const hit of response.hits) {
    lines.push(`### ${hit.title}`);
    lines.push(hit.url);
    if (hit.publishedDate) lines.push(`Published: ${hit.publishedDate}`);
    if (hit.snippet) lines.push("", hit.snippet.trim());
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function describeErrorBody(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as unknown;
    detail = isRecord(parsed) ? asString(parsed.error) ?? asString(parsed.message) ?? "" : "";
  } catch {
    detail = "";
  }
  return detail
    ? `Provider returned ${response.status}: ${detail}`
    : `Provider returned status ${response.status}`;
}

function humanizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
