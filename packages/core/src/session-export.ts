import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { scrubPII } from "./scrub.js";

/**
 * Session export: turn a finished session into a shareable artifact in one
 * of three formats — `jsonl` (the raw transcript, copied verbatim), `md`
 * (readable narrative where tool calls collapse into <details> blocks), and
 * `html` (the markdown body plus a minimal standalone page). Target
 * resolution: a bare format keyword means "default filename in cwd"; a
 * directory means "default filename inside it"; any other path is taken
 * literally and its extension picks the format. Design follows the
 * documented command-code export mechanism; all wording is original.
 */

export const EXPORT_FORMATS = new Set(["html", "jsonl", "md"]);

export type ExportFormat = "html" | "jsonl" | "md";

export interface ExportTarget {
  format: ExportFormat;
  path: string;
}

/** Parse `/export` arguments into a concrete target. */
export function parseExportTarget(options: {
  rawArgs: string;
  cwd: string;
  sessionId: string;
  defaultFormat?: ExportFormat | undefined;
}): ExportTarget | { error: string } {
  const raw = options.rawArgs.trim();
  const defaultFormat = options.defaultFormat ?? "html";
  if (!raw) {
    return { format: defaultFormat, path: path.join(options.cwd, defaultExportFilename(options.sessionId, defaultFormat)) };
  }
  if (EXPORT_FORMATS.has(raw.toLowerCase())) {
    const format = raw.toLowerCase() as ExportFormat;
    return { format, path: path.join(options.cwd, defaultExportFilename(options.sessionId, format)) };
  }
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(options.cwd, raw);
  const lower = absolute.toLowerCase();
  if (lower.endsWith(".jsonl")) return { format: "jsonl", path: absolute };
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return { format: "md", path: absolute };
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return { format: "html", path: absolute };
  return { error: `Cannot infer an export format from "${raw}". Use html | md | jsonl, a directory, or a path ending in .md / .jsonl / .html.` };
}

export function defaultExportFilename(sessionId: string, format: ExportFormat): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${stamp}-${sanitizeSessionId(sessionId)}.${format}`;
}

function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "session";
}

export interface ExportMessage {
  role: unknown;
  content?: unknown;
  /** toolResult messages only. */
  toolCallId?: unknown;
  toolName?: unknown;
}

export interface RenderOptions {
  title: string;
  sessionId: string;
  exportedAt: string;
  model?: string | undefined;
  messages: readonly ExportMessage[];
  /** Tools whose calls never appear in exports (internal plumbing). */
  hiddenTools?: ReadonlySet<string> | undefined;
  /** Scrub secrets/PII from tool arguments and results (default true). */
  redact?: boolean | undefined;
}

interface ToolRecord {
  name: string;
  argsSummary: string;
  text: string;
  images: number;
}

const HIDDEN_EXPORT_TOOLS = new Set(["search_tools"]);

/** Collect tool results keyed by call id for the folding pass. */
export function collectToolOutputs(messages: readonly ExportMessage[]): Map<string, ToolRecord> {
  const outputs = new Map<string, ToolRecord>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    if (!id || outputs.has(id)) continue;
    const text = Array.isArray(message.content)
      ? message.content
          .filter(
            (block): block is { type: "text"; text: string } =>
              typeof block === "object" &&
              block !== null &&
              (block as { type?: unknown }).type === "text" &&
              typeof (block as { text?: unknown }).text === "string",
          )
          .map((block) => block.text)
          .join("\n")
      : "";
    outputs.set(id, {
      name: typeof message.toolName === "string" ? message.toolName : "tool",
      argsSummary: "",
      text,
      images: Array.isArray(message.content)
        ? message.content.filter(
            (block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image",
          ).length
        : 0,
    });
  }
  return outputs;
}

function firstLine(text: string, limit = 100): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** One assistant/user/toolResult message → markdown rows (HTML details for tools). */
export function renderMessageRows(
  message: ExportMessage,
  outputs: Map<string, ToolRecord>,
  redact = true,
): string[] {
  const clean = (text: string): string => (redact ? scrubPII(text) : text);
  const rows: string[] = [];
  if (message.role === "user") {
    const text = Array.isArray(message.content)
      ? message.content
          .filter(
            (block): block is { type: "text"; text: string } =>
              typeof block === "object" &&
              block !== null &&
              (block as { type?: unknown }).type === "text" &&
              typeof (block as { text?: unknown }).text === "string",
          )
          .map((block) => block.text)
          .join("\n")
      : typeof message.content === "string"
        ? message.content
        : "";
    if (text.trim()) rows.push(`### 🧑 User\n\n${clean(text.trim())}`);
    return rows;
  }
  if (message.role !== "assistant") return rows;
  const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  let prose = "";
  const flush = (): void => {
    if (prose.trim()) rows.push(`### 🤖 Assistant\n\n${prose.trim()}`);
    prose = "";
  };
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if (block.type === "text" && typeof block.text === "string") {
      prose += clean(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      flush();
      rows.push(`<details>\n<summary>💭 Reasoning</summary>\n\n${clean(block.thinking.trim())}\n\n</details>`);
      continue;
    }
    if (block.type === "toolCall") {
      flush();
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "tool";
      if (HIDDEN_EXPORT_TOOLS.has(name)) continue;
      const record = outputs.get(id);
      const argsSummary = firstLine(clean(safeJson(block.arguments ?? block.args)));
      // Summary lands inside HTML; JSON quotes and angle brackets must not
      // break out of the <summary> element.
      const summary = escapeHtml(`${name}${argsSummary ? ` ${argsSummary}` : ""}`);
      if (!record || (!record.text && record.images === 0)) {
        rows.push(`<details>\n<summary>🔧 ${summary}</summary>\n\n_No result captured._\n\n</details>`);
        continue;
      }
      const body: string[] = [];
      if (record.text) body.push(fence(clean(record.text)));
      if (record.images > 0) body.push(Array.from({ length: record.images }, () => "_[image]_").join("\n"));
      rows.push(`<details>\n<summary>🔧 ${summary}</summary>\n\n${body.join("\n\n")}\n\n</details>`);
    }
  }
  flush();
  return rows;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pick a fence longer than anything in the content. */
export function fence(content: string): string {
  let longest = 3;
  for (const match of content.matchAll(/^(`{3,})/gm)) {
    longest = Math.max(longest, match[1]!.length);
  }
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${content}\n${ticks}`;
}

export function renderSessionMarkdown(options: RenderOptions): string {
  const outputs = collectToolOutputs(options.messages);
  const rows: string[] = [
    `# ${options.title}`,
    "",
    `- Session: \`${options.sessionId}\``,
    `- Model: ${options.model ?? "unknown"}`,
    `- Messages: ${options.messages.length}`,
    `- Exported: ${options.exportedAt}`,
    "",
  ];
  for (const message of options.messages) {
    rows.push(...renderMessageRows(message, outputs));
  }
  rows.push("---", "_Exported from DSCode._");
  return rows.join("\n\n") + "\n";
}

/** Minimal standalone page: tool rows are already HTML, prose is escaped. */
export function renderSessionHtml(options: RenderOptions): string {
  const outputs = collectToolOutputs(options.messages);
  const body: string[] = [];
  for (const message of options.messages) {
    for (const row of renderMessageRows(message, outputs)) {
      if (row.startsWith("<details>") || row.startsWith("### ")) {
        body.push(
          row
            .split("\n\n")
            .map((part) => (part.startsWith("<details>") || part.startsWith("### ") ? part : `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`))
            .join("\n\n"),
        );
      } else {
        body.push(`<p>${escapeHtml(row).replace(/\n/g, "<br>")}</p>`);
      }
    }
  }
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(options.title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5}details{border:1px solid #ddd;border-radius:6px;padding:.5rem .75rem;margin:.5rem 0}summary{cursor:pointer;font-weight:600}pre{background:#f6f6f6;padding:.75rem;overflow:auto;border-radius:4px}h3{margin:1.5rem 0 .5rem}</style>",
    "</head><body>",
    `<h1>${escapeHtml(options.title)}</h1>`,
    `<p>Session <code>${escapeHtml(options.sessionId)}</code> · model ${escapeHtml(options.model ?? "unknown")} · ${options.messages.length} messages · exported ${escapeHtml(options.exportedAt)}</p>`,
    ...body,
    "<hr><p><em>Exported from DSCode.</em></p>",
    "</body></html>",
  ].join("\n");
}
