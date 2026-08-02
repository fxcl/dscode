import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WebSearchError,
  executeWebSearch,
  formatWebSearchResponse,
  searchWithExa,
  searchWithPerplexity,
  searchWithSearchMcp,
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

  describe("searchWithSearchMcp", () => {
    // Fake binaries that let us test spawn-based execution without the real CLI.
    const fakeBinary = join(tmpdir(), `dscode-test-searchmcp-${process.pid}.mjs`);
    const errorBinary = join(tmpdir(), `dscode-test-searchmcp-err-${process.pid}.mjs`);

    beforeAll(() => {
      writeFileSync(
        fakeBinary,
        '#!/usr/bin/env node\nprocess.stdout.write(process.env.DSCODE_TEST_OUTPUT || \'{"pages":[]}\');\n',
      );
      chmodSync(fakeBinary, 0o755);

      writeFileSync(
        errorBinary,
        '#!/usr/bin/env node\nprocess.stderr.write("WebBridge daemon not running");\nprocess.exit(1);\n',
      );
      chmodSync(errorBinary, 0o755);
    });

    afterAll(() => {
      try { unlinkSync(fakeBinary); } catch {}
      try { unlinkSync(errorBinary); } catch {}
      delete process.env.DSCODE_TEST_OUTPUT;
    });

    afterEach(() => {
      delete process.env.DSCODE_TEST_OUTPUT;
    });

    it("normalizes the pages array into hits", async () => {
      process.env.DSCODE_TEST_OUTPUT = JSON.stringify({
        pages: [
          { url: "https://example.com/1", title: "Result One", markdown: "Content one." },
          { url: "https://example.com/2", title: "Result Two", markdown: "Content two." },
        ],
      });

      const response = await searchWithSearchMcp("test query", fakeBinary);

      expect(response.provider).toBe("search-mcp");
      expect(response.query).toBe("test query");
      expect(response.hits).toHaveLength(2);
      expect(response.hits[0]).toMatchObject({
        title: "Result One",
        url: "https://example.com/1",
        snippet: "Content one.",
      });
      expect(response.hits[1].snippet).toBe("Content two.");
    });

    it("falls back to URL when title is missing", async () => {
      process.env.DSCODE_TEST_OUTPUT = JSON.stringify({
        pages: [{ url: "https://example.com/notitle", markdown: "No title here." }],
      });

      const response = await searchWithSearchMcp("query", fakeBinary);

      expect(response.hits).toHaveLength(1);
      expect(response.hits[0].title).toBe("example.com");
    });

    it("throws WebSearchError when the query is empty", async () => {
      await expect(searchWithSearchMcp("   ", fakeBinary)).rejects.toMatchObject({
        name: "WebSearchError",
        provider: "search-mcp",
      });
    });

    it("throws WebSearchError when the binary path is empty", async () => {
      await expect(searchWithSearchMcp("query", "")).rejects.toMatchObject({
        name: "WebSearchError",
        provider: "search-mcp",
      });
    });

    it("truncates long markdown snippets", async () => {
      const longText = "A".repeat(3000);
      process.env.DSCODE_TEST_OUTPUT = JSON.stringify({
        pages: [{ url: "https://example.com/long", title: "Long", markdown: longText }],
      });

      const response = await searchWithSearchMcp("query", fakeBinary);

      expect(response.hits[0].snippet.length).toBeLessThan(longText.length);
      expect(response.hits[0].snippet.endsWith("…")).toBe(true);
    });

    it("throws WebSearchError on non-zero exit", async () => {
      await expect(searchWithSearchMcp("query", errorBinary)).rejects.toMatchObject({
        name: "WebSearchError",
        provider: "search-mcp",
      });
    });

    it("returns empty hits when pages array is absent", async () => {
      process.env.DSCODE_TEST_OUTPUT = JSON.stringify({ message: "no results" });

      const response = await searchWithSearchMcp("query", fakeBinary);

      expect(response.provider).toBe("search-mcp");
      expect(response.hits).toHaveLength(0);
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

    it("routes to the search-mcp client", async () => {
      const dispatchBinary = join(tmpdir(), `dscode-test-searchmcp-dispatch-${process.pid}.mjs`);
      writeFileSync(dispatchBinary, '#!/usr/bin/env node\nprocess.stdout.write(\'{"pages":[]}\');\n');
      chmodSync(dispatchBinary, 0o755);
      try {
        const response = await executeWebSearch("search-mcp", "query", dispatchBinary);
        expect(response.provider).toBe("search-mcp");
      } finally {
        try { unlinkSync(dispatchBinary); } catch {}
      }
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
