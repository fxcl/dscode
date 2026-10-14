import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Read-only scanning of other coding agents' local session transcripts, used
 * to cold-start taste learning from a user's existing history. Only well-known
 * per-user directories are touched and nothing is ever written back.
 */

export interface CompetitorSessionSource {
  agent: "claude-code" | "codex" | "cursor";
  prompts: string[];
}

export interface CompetitorScanOptions {
  /** Max sessions read per agent (newest first). */
  maxSessions?: number;
  /** Max prompts kept per session. */
  maxPromptsPerSession?: number;
  /** Max prompt length kept. */
  maxPromptChars?: number;
}

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_MAX_PROMPTS_PER_SESSION = 30;
const DEFAULT_MAX_PROMPT_CHARS = 600;

/** Claude Code encodes a project path into a directory name by dash-joining. */
export function claudeCodeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Cursor stores sessions under ~/.cursor/projects/<encoded>/agent-transcripts.
 * The exact encoding of the project directory name has drifted across
 * versions, so several plausible dash-join variants are generated and each is
 * probed; whichever exists is used.
 */
export function cursorProjectDirNames(projectPath: string): string[] {
  const normalized = projectPath.replaceAll("/", "\\");
  const variants = new Set<string>([
    normalized.replace(/[^a-zA-Z0-9]/g, "-"),
    normalized.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase(),
    normalized.toLowerCase().replace(/[^a-z0-9]/g, "-"),
  ]);
  return [...variants].filter(Boolean);
}

/**
 * Best-effort user-prompt extraction from Cursor agent transcripts. The files
 * have appeared both as JSONL and as whole-file JSON (array or messages
 * object), so both shapes are attempted with the same schema-drift-tolerant
 * user-message matcher used for Codex.
 */
export function extractCursorPrompts(content: string, maxPrompts: number, maxChars: number): string[] {
  const prompts: string[] = [];
  const consider = (parsed: unknown): void => {
    if (prompts.length >= maxPrompts) return;
    const message = findUserMessage(parsed, 0);
    if (!message) return;
    const cleaned = cleanPrompt(messageTextFrom(message.content), maxChars);
    if (cleaned) prompts.push(cleaned);
  };
  const trimmed = content.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return prompts;
    }
    if (Array.isArray(parsed)) for (const entry of parsed) consider(entry);
    return prompts;
  }
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (isRecord(parsed) && Array.isArray(parsed.messages)) {
        for (const entry of parsed.messages) consider(entry);
      } else {
        consider(parsed);
      }
      if (prompts.length > 0) return prompts;
      // Fall through to line-by-line scanning for NDJSON-with-noise files.
    }
  }
  for (const line of trimmed.split("\n")) {
    if (prompts.length >= maxPrompts) break;
    const candidate = line.trim();
    if (!candidate) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    consider(parsed);
  }
  return prompts;
}

function homeDir(home?: string): string {
  return home ?? os.homedir();
}

/** Extract genuine user prompts from one Claude Code session JSONL file. */
export function extractClaudeCodePrompts(content: string, maxPrompts: number, maxChars: number): string[] {
  const prompts: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "user") continue;
    const message = isRecord(parsed.message) ? parsed.message : undefined;
    const text = messageTextFrom(message?.content);
    const cleaned = cleanPrompt(text, maxChars);
    if (cleaned) prompts.push(cleaned);
    if (prompts.length >= maxPrompts) break;
  }
  return prompts;
}

/**
 * Best-effort user-prompt extraction from Codex rollout JSONL. The rollout
 * schema has drifted across versions, so match any record that carries a
 * user-role message payload instead of pinning one envelope shape.
 */
export function extractCodexPrompts(content: string, maxPrompts: number, maxChars: number): string[] {
  const prompts: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = findUserMessage(parsed, 0);
    if (!message) continue;
    const cleaned = cleanPrompt(messageTextFrom(message.content), maxChars);
    if (cleaned) prompts.push(cleaned);
    if (prompts.length >= maxPrompts) break;
  }
  return prompts;
}

function findUserMessage(value: unknown, depth: number): { role: "user"; content: unknown } | undefined {
  if (depth > 4 || !isRecord(value)) return undefined;
  if (value.role === "user") {
    const type = value.type;
    if (type === undefined || type === "message" || type === "user") {
      if (value.content !== undefined) return { role: "user", content: value.content };
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const hit = findUserMessage(child, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function messageTextFrom(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result" || block.type === "tool_use") return "";
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Drop meta noise (system reminders, command wrappers, continuations). */
function cleanPrompt(text: string, maxChars: number): string | undefined {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("<")) return undefined; // <system-reminder>, <command-…>, etc.
  if (trimmed.startsWith("Caveat:")) return undefined;
  if (/^\[PLAN MODE/.test(trimmed)) return undefined;
  if (trimmed.length < 8) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function listFilesNewestFirst(dir: string, limit: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => name.endsWith(".jsonl"));
  const withTimes = await Promise.all(
    files.map(async (name) => {
      const full = path.join(dir, name);
      try {
        return { full, mtimeMs: (await stat(full)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return withTimes
    .filter((entry): entry is { full: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.full);
}

async function readPrompts(files: readonly string[], maxPrompts: number, maxChars: number, extract: typeof extractClaudeCodePrompts): Promise<string[]> {
  const prompts: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    prompts.push(...extract(content, Math.max(0, maxPrompts - prompts.length), maxChars));
    if (prompts.length >= maxPrompts) break;
  }
  return prompts;
}

/** Scan Claude Code sessions for the given project and return user prompts. */
export async function scanClaudeCodePrompts(
  projectPath: string,
  options: CompetitorScanOptions & { home?: string } = {},
): Promise<CompetitorSessionSource | undefined> {
  const root = path.join(
    homeDir(options.home),
    ".claude",
    "projects",
    claudeCodeProjectDirName(projectPath),
  );
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxPerSession = options.maxPromptsPerSession ?? DEFAULT_MAX_PROMPTS_PER_SESSION;
  const maxChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const files = await listFilesNewestFirst(root, maxSessions);
  if (files.length === 0) return undefined;
  const prompts = await readPrompts(files, maxPerSession * maxSessions, maxChars, extractClaudeCodePrompts);
  return prompts.length > 0 ? { agent: "claude-code", prompts } : undefined;
}

/** Scan Codex rollout sessions (project filter is best-effort: whole store). */
export async function scanCodexPrompts(
  options: CompetitorScanOptions & { home?: string } = {},
): Promise<CompetitorSessionSource | undefined> {
  const root = path.join(homeDir(options.home), ".codex", "sessions");
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxPerSession = options.maxPromptsPerSession ?? DEFAULT_MAX_PROMPTS_PER_SESSION;
  const maxChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const files = await listCodexRolloutFiles(root, maxSessions);
  if (files.length === 0) return undefined;
  const prompts = await readPrompts(files, maxPerSession * maxSessions, maxChars, extractCodexPrompts);
  return prompts.length > 0 ? { agent: "codex", prompts } : undefined;
}

async function listCodexRolloutFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= limit * 3) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort().reverse()) {
      const full = path.join(dir, entry);
      if (files.length >= limit * 3) return;
      if (entry.endsWith(".jsonl")) files.push(full);
      else void walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return files.slice(0, limit);
}

/** Scan Cursor agent transcripts for the given project (encoding probed). */
export async function scanCursorPrompts(
  projectPath: string,
  options: CompetitorScanOptions & { home?: string } = {},
): Promise<CompetitorSessionSource | undefined> {
  const projectsRoot = path.join(homeDir(options.home), ".cursor", "projects");
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxPerSession = options.maxPromptsPerSession ?? DEFAULT_MAX_PROMPTS_PER_SESSION;
  const maxChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  for (const dirName of cursorProjectDirNames(projectPath)) {
    const transcripts = path.join(projectsRoot, dirName, "agent-transcripts");
    const files = await listTranscriptFiles(transcripts, maxSessions);
    if (files.length === 0) continue;
    const prompts = await readPrompts(files, maxPerSession * maxSessions, maxChars, extractCursorPrompts);
    if (prompts.length > 0) return { agent: "cursor", prompts };
  }
  return undefined;
}

/** Newest-first transcript files; Cursor uses .jsonl/.json (or extension-less). */
async function listTranscriptFiles(dir: string, limit: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => /\.(jsonl|json)$/.test(name) || !name.includes("."));
  const withTimes = await Promise.all(
    files.map(async (name) => {
      const full = path.join(dir, name);
      try {
        return { full, mtimeMs: (await stat(full)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return withTimes
    .filter((entry): entry is { full: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.full);
}

/** Scan every supported competitor agent; sources with no sessions are omitted. */
export async function scanAllCompetitorPrompts(
  projectPath: string,
  options: CompetitorScanOptions & { home?: string } = {},
): Promise<CompetitorSessionSource[]> {
  const sources = await Promise.all([
    scanClaudeCodePrompts(projectPath, options),
    scanCodexPrompts(options),
    scanCursorPrompts(projectPath, options),
  ]);
  return sources.filter((source): source is CompetitorSessionSource => source !== undefined);
}
