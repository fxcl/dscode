import { afterEach, describe, expect, it, vi } from "vitest";
import { searchArXiv } from "../packages/core/src/science-connectors.js";

/** Build a minimal Response-like object backed by a static body. */
function mockResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => body,
  } as Response;
}

/**
 * Realistic arXiv Atom feed mirroring what `export.arxiv.org/api/query`
 * actually returns: a feed-level `<feed>` with the default Atom namespace,
 * plus per-entry `<title type="html">` attributes and self-closing
 * `<link title="pdf"/>` elements.
 */
const REALISTIC_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <link href="http://arxiv.org/api/query" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query</title>
  <id>http://arxiv.org/api/query</id>
  <updated>2024-06-01T00:00:00Z</updated>
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-06-01T00:00:00Z</updated>
    <published>2024-06-01T00:00:00Z</published>
    <title type="html">A Novel Approach to Transformer Quantization</title>
    <summary type="html">We propose a new quantization technique
      that reduces memory usage by 4x with minimal accuracy loss.</summary>
    <author>
      <name>Alice Smith</name>
      <arxiv:affiliation>MIT</arxiv:affiliation>
    </author>
    <author>
      <name>Bob Jones</name>
    </author>
    <arxiv:doi>10.1234/arxiv.2401.00001</arxiv:doi>
    <category scheme="http://arxiv.org/schemas/atom" term="cs.LG"/>
    <link xmlns="http://www.w3.org/2005/Atom" href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html"/>
    <link xmlns="http://www.w3.org/2005/Atom" href="http://arxiv.org/pdf/2401.00001v1" rel="related" type="application/pdf" title="pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v2</id>
    <updated>2024-06-15T00:00:00Z</updated>
    <published>2024-06-10T00:00:00Z</published>
    <title>Another Paper Without Type Attribute</title>
    <summary>Plain summary text.</summary>
    <author>
      <name>Carol Lee</name>
    </author>
    <link href="http://arxiv.org/pdf/2401.00002v2" title="pdf"/>
  </entry>
</feed>`;

/** Prefixed (atom:entry) form to verify namespace stripping. */
const PREFIXED_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
  <atom:entry>
    <atom:id>http://arxiv.org/abs/2402.99999v1</atom:id>
    <atom:title type="html">Prefixed Entry Title</atom:title>
    <atom:summary type="html">Prefixed summary.</atom:summary>
    <atom:published>2024-02-01T00:00:00Z</atom:published>
    <atom:author>
      <atom:name>Dave Kim</atom:name>
    </atom:author>
    <atom:link href="http://arxiv.org/pdf/2402.99999v1" title="pdf"/>
  </atom:entry>
</atom:feed>`;

/** Empty feed edge case. */
const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
</feed>`;

/** Entry missing the optional PDF link — verify the /abs/ → /pdf/ fallback. */
const NO_PDF_LINK = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2403.11111v1</id>
    <title>No PDF Link Here</title>
    <summary>Just the basics.</summary>
    <published>2024-03-01T00:00:00Z</published>
    <author>
      <name>Eve Park</name>
    </author>
    <link href="http://arxiv.org/abs/2403.11111v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

describe("searchArXiv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a realistic Atom feed with namespaces, attributes, and self-closing links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse(REALISTIC_ATOM)),
    );

    const results = await searchArXiv("transformer quantization", 5);

    expect(results).toHaveLength(2);

    const [first, second] = results;
    expect(first).toEqual({
      id: "http://arxiv.org/abs/2401.00001v1",
      title: "A Novel Approach to Transformer Quantization",
      summary:
        "We propose a new quantization technique that reduces memory usage by 4x with minimal accuracy loss.",
      authors: ["Alice Smith", "Bob Jones"],
      published: "2024-06-01T00:00:00Z",
      pdfUrl: "http://arxiv.org/pdf/2401.00001v1",
    });

    // Whitespace-collapsed second title (no type attribute on this one).
    expect(second?.title).toBe("Another Paper Without Type Attribute");
    // Self-closing <link href=... title="pdf"/> with no other attrs.
    expect(second?.pdfUrl).toBe("http://arxiv.org/pdf/2401.00002v2");
    expect(second?.authors).toEqual(["Carol Lee"]);
  });

  it("strips atom: namespace prefixes and still parses entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse(PREFIXED_ATOM)),
    );

    const results = await searchArXiv("anything", 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("http://arxiv.org/abs/2402.99999v1");
    expect(results[0]?.title).toBe("Prefixed Entry Title");
    expect(results[0]?.authors).toEqual(["Dave Kim"]);
    expect(results[0]?.pdfUrl).toBe("http://arxiv.org/pdf/2402.99999v1");
  });

  it("returns an empty array when the feed has no entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse(EMPTY_FEED)),
    );

    const results = await searchArXiv("nothing", 10);

    expect(results).toEqual([]);
  });

  it("falls back to deriving the PDF URL from the id when no pdf link is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse(NO_PDF_LINK)),
    );

    const results = await searchArXiv("fallback", 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.pdfUrl).toBe("http://arxiv.org/pdf/2403.11111v1");
  });

  it("throws when the upstream arXiv API returns a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("upstream error", 503)),
    );

    await expect(searchArXiv("anything", 1)).rejects.toThrow(
      /Failed to fetch from arXiv API/,
    );
  });
});