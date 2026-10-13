import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getDSCodeAgentDir } from "./auth.js";
import { renderToolCall } from "./tool-ui.js";

/**
 * On-demand product knowledge: bundled skill/reference documents are NOT put
 * into the system prompt — the model asks for a topic and reads the document
 * itself. Keeps the static prompt small while keeping the knowledge reachable.
 */

const KNOWLEDGE_READ_CAP_CHARS = 24_000;
const MAX_FILES = 200;

export interface KnowledgeFile {
  /** Path relative to its search root. */
  relativePath: string;
  /** Absolute path. */
  absolutePath: string;
  /** First "# " heading, when present. */
  title: string;
  sizeBytes: number;
}

function knowledgeRoots(agentDir: string): string[] {
  return [path.join(agentDir, "skills")];
}

function extractTitle(content: string): string {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

/** Collect markdown knowledge files under the given roots (newest not required). */
export async function listKnowledgeFiles(roots: readonly string[]): Promise<KnowledgeFile[]> {
  const files: KnowledgeFile[] = [];
  for (const root of roots) {
    await collectRoot(root, root, 0, files);
    if (files.length >= MAX_FILES) break;
  }
  return files.slice(0, MAX_FILES);
}

async function collectRoot(root: string, dir: string, depth: number, files: KnowledgeFile[]): Promise<void> {
  if (depth > 3 || files.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (files.length >= MAX_FILES) return;
    const full = path.join(dir, entry);
    if (entry.endsWith(".md")) {
      try {
        const stat = await readFile(full, "utf8");
        const relativePath = path.relative(root, full).replaceAll("\\", "/");
        files.push({
          relativePath,
          absolutePath: full,
          title: extractTitle(stat),
          sizeBytes: Buffer.byteLength(stat, "utf8"),
        });
      } catch {
        // unreadable file — skip
      }
    } else {
      await collectRoot(root, full, depth + 1, files);
    }
  }
}

/** Score a file against a topic: basename hits outrank path hits. */
export function pickBestMatch(files: readonly KnowledgeFile[], topic: string): KnowledgeFile | undefined {
  const needle = topic.trim().toLowerCase();
  if (!needle) return undefined;
  let best: { file: KnowledgeFile; score: number } | undefined;
  for (const file of files) {
    const base = path.basename(file.relativePath).toLowerCase();
    let score = 0;
    if (base.includes(needle)) score += 4;
    if (base.replace(/\.md$/, "") === needle) score += 6;
    if (file.relativePath.toLowerCase().includes(needle)) score += 2;
    if (file.title.toLowerCase().includes(needle)) score += 2;
    if (score > 0 && (!best || score > best.score)) best = { file, score };
  }
  return best?.file;
}

export function formatKnowledgeListing(files: readonly KnowledgeFile[]): string {
  return files
    .map((file) => {
      const title = file.title ? ` — ${file.title}` : "";
      return `- ${file.relativePath}${title} (${Math.max(1, Math.round(file.sizeBytes / 1024))} KB)`;
    })
    .join("\n");
}

/** Read one knowledge file, refusing anything that escapes its root. */
export async function readKnowledgeFile(root: string, relativePath: string): Promise<string | undefined> {
  const absolute = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (path.relative(normalizedRoot, absolute).startsWith("..")) return undefined;
  try {
    const content = await readFile(absolute, "utf8");
    return content.length > KNOWLEDGE_READ_CAP_CHARS
      ? `${content.slice(0, KNOWLEDGE_READ_CAP_CHARS)}\n\n[truncated at ${KNOWLEDGE_READ_CAP_CHARS} characters]`
      : content;
  } catch {
    return undefined;
  }
}

/** Structured details for the dscode_knowledge tool results. */
interface KnowledgeDetails {
  count: number;
  matched?: boolean;
  file?: string;
  error?: string;
}

/** Register the dscode_knowledge tool against the bundled skills directory. */
export function registerKnowledgeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dscode_knowledge",
    label: "DSCode knowledge",
    description:
      "Read DSCode's own bundled documentation (skills, references). Use before asking the user how DSCode features work.",
    promptSnippet: "dscode_knowledge: look up DSCode product documentation on demand",
    promptGuidelines: [
      "Call with no topic to list available documents.",
      "Call with a topic (e.g. 'skills', 'mod', 'sandbox') to read the matching document.",
    ],
    parameters: Type.Object({
      topic: Type.Optional(Type.String({ description: "Document name or topic to search for." })),
    }),
    renderShell: "self" as const,
    executionMode: "parallel",
    async execute(_id, params): Promise<AgentToolResult<KnowledgeDetails>> {
      const agentDir = getDSCodeAgentDir();
      const roots = knowledgeRoots(agentDir);
      const files = await listKnowledgeFiles(roots);
      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "No bundled knowledge documents are installed." }],
          details: { count: 0 },
        };
      }
      const topic = typeof params.topic === "string" ? params.topic.trim() : "";
      if (!topic) {
        return {
          content: [
            {
              type: "text",
              text: `Bundled documents:\n${formatKnowledgeListing(files)}\n\nCall again with a topic to read one.`,
            },
          ],
          details: { count: files.length },
        };
      }
      const match = pickBestMatch(files, topic);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No document matches "${topic}". Available:\n${formatKnowledgeListing(files)}`,
            },
          ],
          details: { count: files.length, matched: false },
        };
      }
      const root = roots.find((candidate) => match.absolutePath.startsWith(candidate)) ?? roots[0]!;
      const content = await readKnowledgeFile(root, match.relativePath);
      if (!content) {
        throw new Error(`Knowledge document "${match.relativePath}" could not be read.`);
      }
      return {
        content: [{ type: "text", text: content }],
        details: { count: files.length, matched: true, file: match.relativePath },
      };
    },
    renderCall(args, theme, context) {
      return renderToolCall(
        context.isPartial ? "Reading docs" : "Read docs",
        String(args.topic ?? "(list)"),
        theme,
        context,
      );
    },
  });
}
