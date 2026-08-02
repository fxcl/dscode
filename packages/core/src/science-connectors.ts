export interface ArXivResult {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  pdfUrl: string;
}

export interface HuggingFaceModelResult {
  id: string;
  downloads: number;
  likes: number;
  pipeline_tag: string;
}

// arXiv's Atom feed uses the default `xmlns="http://www.w3.org/2005/Atom"`
// namespace declaration. Some clients also receive the `<atom:entry>` prefix
// form or `<arxiv:*>` namespace-qualified tags. Strip both `xmlns*`
// attributes and namespace prefixes so downstream regexes can match bare
// element names. Feynman uses `fast-xml-parser` with `removeNSPrefix: true`
// to achieve the same effect; we avoid that dependency here with a small
// pre-normalization pass.
function normalizeAtomXml(text: string): string {
  return text
    .replace(/\s+xmlns(?::[A-Za-z][\w.-]*)?="[^"]*"/g, "")
    .replace(/(<\/?)[A-Za-z][\w.-]*:/g, "$1");
}

// Build a regex fragment that matches an element name with optional namespace
// prefix: `entry` → `(?:[a-zA-Z][\w.-]*:)?entry`.
function tagWithNs(name: string): string {
  return `(?:[a-zA-Z][\\w.-]*:)?${name}`;
}

// Per-element regexes allow optional attributes (e.g. `<title type="html">`)
// and self-closing tags (e.g. `<link ... title="pdf"/>`).
const ENTRY_OPEN_RE = new RegExp(`<${tagWithNs("entry")}\\b[^>]*>`, "g");
const ENTRY_CLOSE_RE = new RegExp(`</${tagWithNs("entry")}>`, "g");
const ID_RE = new RegExp(`<${tagWithNs("id")}\\b[^>]*>([\\s\\S]*?)</${tagWithNs("id")}>`);
const TITLE_RE = new RegExp(`<${tagWithNs("title")}\\b[^>]*>([\\s\\S]*?)</${tagWithNs("title")}>`);
const SUMMARY_RE = new RegExp(`<${tagWithNs("summary")}\\b[^>]*>([\\s\\S]*?)</${tagWithNs("summary")}>`);
const PUBLISHED_RE = new RegExp(`<${tagWithNs("published")}\\b[^>]*>([\\s\\S]*?)</${tagWithNs("published")}>`);
// `<author>…<name>…</name>…</author>` — name can appear anywhere inside author.
const AUTHOR_RE = new RegExp(`<${tagWithNs("author")}\\b[^>]*>([\\s\\S]*?)</${tagWithNs("author")}>`, "g");
const NAME_RE = new RegExp(`<${tagWithNs("name")}\\b[^>]*>([\\s\\S]*?)</${tagWithNs("name")}>`);
// `<link ... href="..." title="pdf"/>` — title attr can appear before or after
// href, and the tag may self-close.
const PDF_LINK_RE = new RegExp(`<${tagWithNs("link")}\\b([^>]*?)(\\/?)>`, "g");

function readAttribute(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
  const match = attrs.match(re);
  return match?.[1];
}

export async function searchArXiv(query: string, limit: number = 10): Promise<ArXivResult[]> {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from arXiv API: ${response.statusText}`);
  }
  const rawText = await response.text();
  // Tolerate either bare (`<entry>`) or prefixed (`<atom:entry>`) forms; both
  // are normalized so downstream regexes work on plain element names.
  const text = normalizeAtomXml(rawText);

  // Walk the text by finding each entry-open position and the matching close.
  const entries: ArXivResult[] = [];
  ENTRY_OPEN_RE.lastIndex = 0;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = ENTRY_OPEN_RE.exec(text)) !== null) {
    const openEnd = ENTRY_OPEN_RE.lastIndex;
    ENTRY_CLOSE_RE.lastIndex = openEnd;
    const closeMatch = ENTRY_CLOSE_RE.exec(text);
    if (!closeMatch) break;
    const entryData = text.slice(openEnd, ENTRY_CLOSE_RE.lastIndex - closeMatch[0].length);

    const idMatch = entryData.match(ID_RE);
    const titleMatch = entryData.match(TITLE_RE);
    const summaryMatch = entryData.match(SUMMARY_RE);
    const publishedMatch = entryData.match(PUBLISHED_RE);

    const id = idMatch?.[1]?.trim() ?? "";
    const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const summary = summaryMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const published = publishedMatch?.[1]?.trim() ?? "";

    // PDF link: find any <link> whose attributes include title="pdf" and pull
    // its href. Falls back to deriving the canonical PDF URL from the id.
    let pdfUrl = "";
    PDF_LINK_RE.lastIndex = 0;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = PDF_LINK_RE.exec(entryData)) !== null) {
      const attrs = linkMatch[1] ?? "";
      if (/\btitle\s*=\s*"pdf"/i.test(attrs)) {
        pdfUrl = readAttribute(attrs, "href") ?? "";
        break;
      }
    }
    if (!pdfUrl) {
      pdfUrl = id.replace("/abs/", "/pdf/");
    }

    const authors: string[] = [];
    AUTHOR_RE.lastIndex = 0;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = AUTHOR_RE.exec(entryData)) !== null) {
      const inner = authorMatch[1] ?? "";
      const nameMatch = inner.match(NAME_RE);
      if (nameMatch?.[1]) authors.push(nameMatch[1].trim());
    }

    entries.push({
      id,
      title,
      summary,
      authors,
      published,
      pdfUrl,
    });
    ENTRY_OPEN_RE.lastIndex = ENTRY_CLOSE_RE.lastIndex;
  }

  return entries;
}

export async function searchHuggingFaceModels(query: string, limit: number = 10): Promise<HuggingFaceModelResult[]> {
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from HuggingFace API: ${response.statusText}`);
  }
  const data = await response.json() as any[];

  return data.map(item => ({
    id: item.modelId || item.id || "",
    downloads: item.downloads || 0,
    likes: item.likes || 0,
    pipeline_tag: item.pipeline_tag || ""
  }));
}
