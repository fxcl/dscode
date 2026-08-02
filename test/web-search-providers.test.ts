import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebSearchError,
  executeWebSearch,
  formatWebSearchResponse,
  searchWithExa,
  searchWithPerplexity,
  type WebSearchResponse,
} from "../packages/core/src/web-search-providers.js";

/** Build a minimal Response-like object backed by a static body. */
function mockResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

/** Capture the request so assertions can inspect headers/body. */
function installFetch(responder: (url: string, init?: RequestInit) => Response): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  });
  return { calls };
}

describe("web search providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("searchWithExa", () => {
    it("normalizes the Exa results array into hits", async () => {
      const { calls } = installFetch(() =>
        mockResponse(
          JSON.stringify({
            results: [
              {
                title: "TypeScript Handbook",
                url: "https://www.typescriptlang.org/docs/",
                text: "TypeScript is a strongly typed programming language.",
                publishedDate: "2024-01-15",
              },
              {
                url: "https://example.com/no-title",
                text: "A result missing a title.",
              },
            ],
          }),
        ),
      );

      const response = await searchWithExa("typescript handbook", "exa-key");

      expect(response.provider).toBe("exa");
      expect(response.query).toBe("typescript handbook");
      expect(response.hits).toHaveLength(2);
      expect(response.hits[0]).toMatchObject({
        title: "TypeScript Handbook",
        url: "https://www.typescriptlang.org/docs/",
        publishedDate: "2024-01-15",
      });
      // A missing title falls back to the URL.
      expect(response.hits[1].title).toBe("https://example.com/no-title");

      const init = calls[0]?.init;
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("exa-key");
    });

    it("throws WebSearchError when the API key is missing", async () => {
      installFetch(() => mockResponse("{}"));
      await expect(searchWithExa("query", "  ")).rejects.toMatchObject({
        name: "WebSearchError",
        provider: "exa",
      });
    });

    it("surfaces the HTTP status on a failed request", async () => {
      installFetch(() =>
        mockResponse(JSON.stringify({ error: "Invalid API key" }), 401),
      );
      await expect(searchWithExa("query", "bad-key")).rejects.toMatchObject({
        name: "WebSearchError",
        provider: "exa",
        status: 401,
      });
    });

    it("drops results that have no URL", async () => {
      installFetch(() =>
        mockResponse(
          JSON.stringify({
            results: [
              { title: "Has URL", url: "https://keep.example" },
              { title: "No URL", text: "dropped" },
            ],
          }),
        ),
      );
      const response = await searchWithExa("query", "exa-key");
      expect(response.hits).toHaveLength(1);
      expect(response.hits[0].url).toBe("https://keep.example");
    });
  });

  describe("searchWithPerplexity", () => {
    it("returns the synthesized answer and cited URLs", async () => {
      const { calls } = installFetch(() =>
        mockResponse(
          JSON.stringify({
            choices: [{ message: { content: "TypeScript adds static types." } }],
            citations: [
              "https://www.typescriptlang.org/",
              "https://en.wikipedia.org/wiki/TypeScript",
            ],
          }),
        ),
      );

      const response = await searchWithPerplexity("what is typescript", "pplx-key");

      expect(response.provider).toBe("perplexity");
      expect(response.answer).toBe("TypeScript adds static types.");
      expect(response.hits.map((hit) => hit.url)).toEqual([
        "https://www.typescriptlang.org/",
        "https://en.wikipedia.org/wiki/TypeScript",
      ]);

      const init = calls[0]?.init;
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer pplx-key",
      );
    });

    it("throws WebSearchError when the API key is missing", async () => {
      installFetch(() => mockResponse("{}"));
      await expect(searchWithPerplexity("query", "")).rejects.toMatchObject({
        name: "WebSearchError",
        provider: "perplexity",
      });
    });
  });

  describe("executeWebSearch dispatch", () => {
    it("routes to the exa client", async () => {
      const { calls } = installFetch((url) => {
        if (url.includes("exa.ai")) return mockResponse(JSON.stringify({ results: [] }));
        throw new Error(`unexpected url ${url}`);
      });
      const response = await executeWebSearch("exa", "query", "exa-key");
      expect(response.provider).toBe("exa");
      expect(calls[0]?.url).toContain("api.exa.ai");
    });

    it("routes to the perplexity client", async () => {
      const { calls } = installFetch((url) => {
        if (url.includes("perplexity.ai")) {
          return mockResponse(JSON.stringify({ choices: [{ message: { content: "ans" } }] }));
        }
        throw new Error(`unexpected url ${url}`);
      });
      const response = await executeWebSearch("perplexity", "query", "pplx-key");
      expect(response.provider).toBe("perplexity");
      expect(calls[0]?.url).toContain("api.perplexity.ai");
    });
  });

  describe("formatWebSearchResponse", () => {
    it("renders the answer followed by cited hits", () => {
      const response: WebSearchResponse = {
        provider: "perplexity",
        query: "q",
        answer: "An answer.",
        hits: [
          { title: "Hit One", url: "https://one.example", snippet: "Snippet text" },
        ],
      };
      const rendered = formatWebSearchResponse(response);
      expect(rendered).toContain("An answer.");
      expect(rendered).toContain("### Hit One");
      expect(rendered).toContain("https://one.example");
      expect(rendered).toContain("Snippet text");
    });

    it("reports no results when the hits list is empty", () => {
      const rendered = formatWebSearchResponse({
        provider: "exa",
        query: "q",
        hits: [],
      });
      expect(rendered).toBe("No results found.");
    });
  });

  describe("WebSearchError", () => {
    it("carries the provider and optional status", () => {
      const err = new WebSearchError("exa", "boom", 502);
      expect(err.name).toBe("WebSearchError");
      expect(err.provider).toBe("exa");
      expect(err.status).toBe(502);
      expect(err instanceof Error).toBe(true);
    });
  });
});
