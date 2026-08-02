/**
 * Web search execution layer for non-DeepSeek providers.
 *
 * DeepSeek performs web search server-side (see optimizeDeepSeekResponsesPayload).
 * Perplexity, Exa, and Google Gemini grounding require an explicit client-side HTTP
 * call, exposed to the agent as a `web_search` tool. search-mcp drives a local
 * Chrome browser through Kimi WebBridge — no API key, always live, login-aware.
 *
 * This module contains pure, testable functions — no file system, no global state
 * (except spawn-based search-mcp which is itself a pure subprocess call) — so it
 * can be unit tested with mocked fetch / spawnCapture.
 */

import { spawn } from "node:child_process";
import { asString, isRecord } from "./type-guards.js";

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
  /** Perplexity and Google return a synthesized answer; Exa does not. */
  answer?: string;
}

export type WebSearchExecProvider = "exa" | "perplexity" | "google" | "search-mcp";

/** search-mcp search depth — maps to result count: low=6, medium=12, high=24, crazy=48. */
export type SearchMcpLevel = "low" | "medium" | "high" | "crazy";

export interface WebSearchExecOptions {
  /** Maximum number of results to request. Defaults to 5. */
  numResults?: number;
  /** Abort the request early. */
  signal?: AbortSignal;
  /** search-mcp only: restrict results to a domain (e.g. "github.com"). */
  searchMcpSite?: string;
}

const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
/** search-mcp drives real Chrome, so it needs a much longer timeout. */
const SEARCH_MCP_TIMEOUT_MS = 180_000;

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

/**
 * Parse a JSON response body. The provider label is required so the resulting
 * `WebSearchError` carries an accurate `.provider` field regardless of who called.
 */
async function readJson(
  response: Response,
  provider: WebSearchExecProvider,
): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new WebSearchError(
      provider,
      `Unexpected response body (status ${response.status})`,
      response.status,
    );
  }
}

/** Domain-aware label for a citation URL (Perplexity does not return titles). */
function urlLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
    throw new WebSearchError("exa", await describeErrorBody(response, "exa"), response.status);
  }

  const payload = await readJson(response, "exa");
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
    .filter((hit) => hit.url.length > 0)
    .slice(0, numResults);

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
    throw new WebSearchError(
      "perplexity",
      await describeErrorBody(response, "perplexity"),
      response.status,
    );
  }

  const payload = await readJson(response, "perplexity");
  const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices.find(isRecord);
  const message = isRecord(firstChoice?.message) ? firstChoice.message : undefined;
  const answer = asString(message?.content);
  const citations = isRecord(payload) && Array.isArray(payload.citations) ? payload.citations : [];

  // Filter out invalid citations first, then cap to numResults. Perplexity returns
  // URLs without titles, so each hit's title falls back to the URL's host so the
  // rendered Markdown is more informative than a bare URL.
  const hits: WebSearchHit[] = citations
    .map((citation): WebSearchHit | undefined => {
      const url = asString(citation);
      if (!url) return undefined;
      return { title: urlLabel(url), url, snippet: "" };
    })
    .filter((hit): hit is WebSearchHit => hit !== undefined)
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
 *
 * The Gemini API expects the key in the `x-goog-api-key` header rather than the
 * `key=` query string. Query-string auth still works for most endpoints but is
 * discouraged because it tends to leak through server logs and referer headers.
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
    response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ googleSearch: {} }],
        }),
        signal: timeoutSignal(DEFAULT_TIMEOUT_MS, options.signal),
      },
    );
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError("google", `Network request failed: ${humanizeError(error)}`);
  }

  if (!response.ok) {
    throw new WebSearchError("google", await describeErrorBody(response, "google"), response.status);
  }

  const payload = await readJson(response, "google");
  const candidates = isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates : [];
  const first = candidates.find(isRecord);
  const answer = asString(
    isRecord(first?.content) && Array.isArray(first.content.parts)
      ? first.content.parts.find((part) => isRecord(part) && typeof part.text === "string")?.text
      : undefined,
  );
  const grounding = isRecord(first?.groundingMetadata) ? first.groundingMetadata : undefined;
  const chunks = Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : [];

  const hits: WebSearchHit[] = chunks
    .filter((chunk): chunk is Record<string, unknown> => isRecord(chunk))
    .map((chunk): WebSearchHit | undefined => {
      const web = isRecord(chunk.web) ? chunk.web : undefined;
      const url = asString(web?.uri);
      const title = asString(web?.title);
      if (!url) return undefined;
      return { title: title ?? urlLabel(url), url, snippet: "" };
    })
    .filter((hit): hit is WebSearchHit => hit !== undefined)
    .slice(0, numResults);

  return {
    provider: "google",
    query,
    hits,
    ...(answer ? { answer } : {}),
  };
}

/**
 * Search the web with search-mcp — a local CLI that drives real Chrome through
 * Kimi WebBridge. No API key required; the binary must be on PATH or at the
 * configured path. Returns auto-fetched page content as markdown snippets.
 *
 * The binary is invoked as:
 *   search-mcp search --json --level <level> [--site <domain>] <query>
 *
 * The JSON envelope contains a `pages` array, each with `url`, `title`, and
 * `markdown`/`content`. We normalize these into WebSearchHit[], truncating
 * each page's markdown to keep the tool output bounded.
 */
export async function searchWithSearchMcp(
  query: string,
  binaryPath: string,
  options: WebSearchExecOptions = {},
): Promise<WebSearchResponse> {
  if (!query.trim()) {
    throw new WebSearchError("search-mcp", "Search query must not be empty");
  }
  if (!binaryPath.trim()) {
    throw new WebSearchError("search-mcp", "search-mcp binary path is not configured");
  }

  const level = resolveSearchMcpLevel(options.numResults);
  const args = ["search", "--json", "--level", level];
  if (options.searchMcpSite) {
    args.push("--site", options.searchMcpSite);
  }
  args.push(query);

  const timeoutMs = SEARCH_MCP_TIMEOUT_MS;
  const stdout = await spawnSearchMcp(binaryPath, args, timeoutMs, options.signal);

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new WebSearchError(
      "search-mcp",
      "search-mcp returned a non-JSON response. Ensure the binary is v0.7.0+ and the WebBridge daemon is running.",
    );
  }

  const pages = isRecord(payload) && Array.isArray(payload.pages) ? payload.pages : [];
  const maxHits = options.numResults ?? DEFAULT_NUM_RESULTS;
  const hits: WebSearchHit[] = pages
    .filter(isRecord)
    .map((page): WebSearchHit | undefined => {
      const url = asString(page.url) ?? asString(page.link);
      const title = asString(page.title) ?? (url ? urlLabel(url) : "Untitled");
      const markdown = asString(page.markdown) ?? asString(page.content) ?? asString(page.text) ?? "";
      if (!url) return undefined;
      return {
        title,
        url,
        snippet: truncateSnippet(markdown),
      };
    })
    .filter((hit): hit is WebSearchHit => hit !== undefined)
    .slice(0, maxHits);

  return { provider: "search-mcp", query, hits };
}

/** Map a result-count hint to a search-mcp level keyword. */
function resolveSearchMcpLevel(numResults?: number): SearchMcpLevel {
  if (numResults === undefined) return "medium";
  if (numResults <= 6) return "low";
  if (numResults <= 12) return "medium";
  if (numResults <= 24) return "high";
  return "crazy";
}

/** Cap snippet length so tool output stays bounded (search-mcp returns full pages). */
function truncateSnippet(markdown: string, maxChars = 1500): string {
  if (markdown.length <= maxChars) return markdown.trim();
  return `${markdown.slice(0, maxChars).trim()}…`;
}

/**
 * Spawn the search-mcp binary and collect stdout. Rejects on non-zero exit or
 * timeout. The signal (if any) forwards an abort to the child process.
 */
function spawnSearchMcp(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      signal,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new WebSearchError("search-mcp", `search-mcp timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WebSearchError("search-mcp", `Failed to launch search-mcp: ${err.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = stderr.trim() || `exit code ${code}`;
        reject(new WebSearchError("search-mcp", detail, code === 2 ? undefined : code ?? undefined));
      }
    });
  });
}

/**
 * Run a search against the configured provider. DeepSeek is handled server-side
 * elsewhere, so only exa/perplexity/google/search-mcp reach this function.
 *
 * For search-mcp the `apiKey` parameter is repurposed as the binary path.
 */
export async function executeWebSearch(
  provider: WebSearchExecProvider,
  query: string,
  apiKey: string,
  options?: WebSearchExecOptions,
): Promise<WebSearchResponse> {
  if (provider === "search-mcp") return searchWithSearchMcp(query, apiKey, options);
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

async function describeErrorBody(
  response: Response,
  provider: WebSearchExecProvider,
): Promise<string> {
  let detail = "";
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as unknown;
    detail = isRecord(parsed) ? asString(parsed.error) ?? asString(parsed.message) ?? "" : "";
  } catch {
    detail = "";
  }
  return detail
    ? `${provider} returned ${response.status}: ${detail}`
    : `${provider} returned status ${response.status}`;
}

function humanizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}