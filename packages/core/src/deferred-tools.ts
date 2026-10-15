/**
 * Deferred tools: when the MCP surface grows large, the schemas of rarely
 * used MCP tools stop being attached to requests. They are listed in the
 * system prompt as one-line TypeScript-style signatures instead, and a
 * search_tools tool loads full schemas on demand — either by capability
 * query or by exact name via "select:". Matched tools are re-activated for
 * the rest of the session. Design follows the documented command-code
 * deferred-tools mechanism (signature list + on-demand schema loading); all
 * wording is original.
 */

export const SEARCH_TOOLS_NAME = "search_tools";
export const SEARCH_TOOLS_DEFAULT_RESULTS = 5;
export const SEARCH_TOOLS_MAX_RESULTS = 20;
/** At this many MCP tools, deferral engages (env DSCODE_DEFERRED_MCP=off disables). */
export const DEFERRED_MCP_TOOL_THRESHOLD = 12;
const SIGNATURE_MAX_FIELD_CHARS = 160;
const SIGNATURE_MAX_TOTAL_CHARS = 640;
const SUMMARY_MAX_CHARS = 120;
const TYPE_MAX_DEPTH = 2;

export interface DeferredToolEntry {
  name: string;
  description: string;
  /** Raw JSON Schema for the tool's parameters. */
  inputSchema: Record<string, unknown> | undefined;
}

interface JsonSchemaNode {
  type?: unknown;
  enum?: unknown;
  items?: unknown;
  properties?: unknown;
  required?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a JSON Schema node as a compact TypeScript-ish type. */
export function renderSchemaType(schema: unknown, depth = 0): string {
  if (!isRecord(schema)) return "any";
  const node = schema as JsonSchemaNode;
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum
      .map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value)))
      .join(" | ");
  }
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const variants = (node.anyOf ?? node.oneOf) as unknown[];
    const rendered = variants
      .slice(0, 4)
      .map((variant) => renderSchemaType(variant, depth + 1))
      .filter((text) => text !== "any" || variants.length === 1);
    if (rendered.length > 0) return rendered.join(" | ");
  }
  if (node.type === "array") {
    return `${renderSchemaType(node.items, depth + 1)}[]`;
  }
  if (node.type === "object" || isRecord(node.properties)) {
    if (depth >= TYPE_MAX_DEPTH) return "object";
    const fields = renderSchemaFields(node, depth);
    return fields === undefined ? "object" : `{ ${fields} }`;
  }
  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type)) {
    const names = node.type.filter((value): value is string => typeof value === "string");
    if (names.length > 0) return names.join(" | ");
  }
  return "any";
}

function renderSchemaFields(node: JsonSchemaNode, depth: number): string | undefined {
  if (!isRecord(node.properties)) return undefined;
  const required = new Set(
    Array.isArray(node.required) ? node.required.filter((value): value is string => typeof value === "string") : [],
  );
  const entries = Object.entries(node.properties as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const ordered = [...entries.filter(([name]) => required.has(name)), ...entries.filter(([name]) => !required.has(name))];
  return ordered
    .map(([name, schema]) => `${name}${required.has(name) ? "" : "?"}: ${renderSchemaType(schema, depth + 1)}`)
    .join(", ");
}

/** One-line `- name{field: type}: summary` signature. */
export function renderToolSignature(entry: DeferredToolEntry): string {
  const summary = firstSentence(entry.description);
  if (!isRecord(entry.inputSchema)) return `- ${entry.name}: ${summary}`;
  const fields = renderSchemaFields(entry.inputSchema as JsonSchemaNode, 0);
  if (fields === undefined) return `- ${entry.name}: ${summary}`;
  const prefix = `- ${entry.name}{`;
  let out = `${prefix}${fields}}`;
  if (out.length > SIGNATURE_MAX_TOTAL_CHARS) {
    // Truncate the field list at a field boundary, then note the elision.
    const parts = fields.split(", ");
    let kept = "";
    for (const part of parts) {
      const candidate = kept ? `${kept}, ${part}` : part;
      const compact = candidate.length > SIGNATURE_MAX_FIELD_CHARS ? `${candidate.slice(0, SIGNATURE_MAX_FIELD_CHARS - 3).trimEnd()}…` : candidate;
      if (kept && `${prefix}${compact}}`.length > SIGNATURE_MAX_TOTAL_CHARS) break;
      kept = compact;
    }
    out = kept ? `${prefix}${kept}, …}` : `${prefix}…}`;
  }
  return `${out}: ${summary}`;
}

function firstSentence(description: string): string {
  const text = description.trim();
  const cut = text.search(/\.\s|\.$|\n/);
  const sentence = (cut === -1 ? text : text.slice(0, cut + 1)).replace(/\s+/g, " ").trim();
  return sentence.length > SUMMARY_MAX_CHARS ? `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : sentence;
}

/**
 * The system-prompt section describing deferred tools. Original wording;
 * carries the same load-bearing rules: signatures are TypeScript notation,
 * call directly when the shape suffices, look up before retrying a rejected
 * call.
 */
export function buildDeferredToolsSection(entries: readonly DeferredToolEntry[]): string {
  if (entries.length === 0) return "";
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return [
    "# Additional tools",
    "",
    `You HAVE the ${sorted.length} tools below, in addition to the ones whose schemas are attached`,
    "to this request. Only their schemas are withheld, to keep the prompt small — the tools",
    "themselves are yours, already connected, and ready to run. Treat them as available in",
    "every sense: when you consider what you can do, plan an approach, or enumerate your tools,",
    "these count.",
    "",
    `To use one, call ${SEARCH_TOOLS_NAME} with a short description of the capability you need`,
    '(or "select:<name>,<name>" for exact tools) to get its full parameter schema, then call it',
    "by name.",
    "",
    'Each entry below reads `- name{arguments}: summary`, where {arguments} is the tool\'s input',
    "schema WRITTEN AS A TYPESCRIPT OBJECT TYPE. Read it as TypeScript: every field is REQUIRED",
    "unless its name ends in `?`, `T[]` is an array of T, `a|b` is a union, and the types are",
    "exact. A `?` is notation — never send it as part of a field name.",
    "If the shape tells you everything you need, call the tool directly — no lookup. Reach for",
    "the lookup when you need what the shape cannot carry: a field's meaning, allowed values,",
    "or how the tool behaves. If a call comes back rejected, look the tool up before retrying —",
    "a second guess at the same shape usually fails the same way.",
    "",
    ...sorted.map(renderToolSignature),
  ].join("\n");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((token) => token.length > 1);
}

/**
 * Search the deferred catalog. "select:<names>" loads exact tools; any other
 * query is scored by token overlap with name + description (IDF-weighted).
 * Only tools that are still deferred (not yet activated) are returned.
 */
export function searchDeferredTools(
  catalog: readonly DeferredToolEntry[],
  query: string,
  options?: { maxResults?: number | undefined; isDeferred?: ((name: string) => boolean) | undefined },
): DeferredToolEntry[] {
  const isDeferred = options?.isDeferred ?? (() => true);
  const maxResults = Math.max(
    1,
    Math.min(SEARCH_TOOLS_MAX_RESULTS, Math.round(options?.maxResults ?? SEARCH_TOOLS_DEFAULT_RESULTS)),
  );
  const available = catalog.filter((entry) => isDeferred(entry.name));
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (trimmed.toLowerCase().startsWith("select:")) {
    const names = trimmed
      .slice("select:".length)
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const results: DeferredToolEntry[] = [];
    for (const name of names) {
      const hit = available.find((entry) => entry.name.toLowerCase() === name);
      if (hit && !results.includes(hit)) results.push(hit);
    }
    return results.slice(0, maxResults);
  }
  const queryTokens = tokenize(trimmed);
  if (queryTokens.length === 0) return [];
  const docs = available.map((entry) => new Set(tokenize(`${entry.name} ${entry.description}`)));
  const idf = new Map<string, number>();
  for (const token of new Set(queryTokens)) {
    const hits = docs.filter((doc) => doc.has(token)).length;
    idf.set(token, Math.log((available.length + 1) / (hits + 0.5)));
  }
  const scored = available
    .map((entry, index) => {
      let score = 0;
      for (const token of queryTokens) {
        if (docs[index]?.has(token)) score += idf.get(token) ?? 0;
      }
      // Name matches dominate description matches.
      const nameTokens = new Set(tokenize(entry.name));
      for (const token of queryTokens) {
        if (nameTokens.has(token)) score += 1.5;
      }
      return { entry, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((hit) => hit.entry);
}

/** Render matched tools as full schema payloads for the search_tools result. */
export function renderLoadedSchemas(entries: readonly DeferredToolEntry[]): string {
  return entries
    .map((entry) => {
      const schema = isRecord(entry.inputSchema) ? JSON.stringify(entry.inputSchema, null, 2) : "{}";
      return [`### ${entry.name}`, entry.description || "(no description)", "", "Parameters JSON Schema:", "```json", schema, "```"].join("\n");
    })
    .join("\n\n");
}

/**
 * Tool-name alias guidance: degraded models sometimes call tools by names they
 * learned elsewhere. The runner cannot silently re-route to another tool, so
 * the alias call is blocked with the exact correct invocation instead — fast,
 * visible, and cheaper than a schema-validation failure loop.
 */
const TOOL_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ["bash_output", "Use write_stdin with the process_id returned by exec_command (omit chars to poll)."],
  ["shell_output", "Use write_stdin with the process_id returned by exec_command (omit chars to poll)."],
  ["task_output", "Use write_stdin with the process_id returned by exec_command (omit chars to poll)."],
  ["task_stop", "Use write_stdin with process_id and terminate: true."],
  ["kill_shell", "Use write_stdin with process_id and terminate: true."],
  ["bash", "Use exec_command — plain bash bypasses DSCode's managed sandbox."],
  ["run_shell_command", "Use exec_command — it runs commands inside the managed sandbox."],
  ["todo_write", "Use update_plan — it publishes the structured plan and keeps its statuses current."],
  ["task_create", "Use update_plan — DSCode tracks multi-step work through the structured plan tool."],
  ["read_multiple_files", "Use read_file once per file (parallel calls are fine)."],
  ["list_dir", "Use list_files with a glob pattern."],
  ["glob", "Use list_files with a glob pattern."],
  ["grep", "Use search_files — it runs ripgrep with literal/regex modes."],
]);

export function describeToolAlias(toolName: string): string | undefined {
  return TOOL_NAME_ALIASES.get(toolName);
}
