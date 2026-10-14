import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message, Model, Models, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/**
 * DSCode taste: durable, confidence-scored user preferences learned from
 * conversations, stored as markdown next to the project and injected into the
 * system prompt. Files live at <cwd>/.dscode/taste/ as either "taste.md" or
 * "{category}/taste.md" (one level of categories, nothing deeper).
 *
 * Learning runs as a small tool-loop agent (commandcode parity): the model
 * iterates with read/write/edit tools over the taste directory instead of
 * returning whole files, so large taste states are amended incrementally.
 */

export const TASTE_DIR_NAME = path.join(".dscode", "taste");
export const TASTE_FILE = "taste.md";

/** A learning bullet must end in a confidence score. */
export const LEARNING_ENTRY_RE = /^- .*\bConfidence:\s*[0-9]+(?:\.[0-9]+)?\s*$/;

export const MAX_TASTE_FILE_BYTES = 16_384;
/** Tool-call turns the learning agent may spend per learning pass. */
export const LEARNING_MAX_TURNS = 8;
const MAX_LEARNED_HASHES = 2_000;
const MIN_BATCH_CHARS = 40;
const MAX_BATCH_MESSAGES = 16;

export function tasteDirFor(cwd: string): string {
  return path.join(cwd, TASTE_DIR_NAME);
}

export function tasteFileFor(cwd: string): string {
  return path.join(tasteDirFor(cwd), TASTE_FILE);
}

/** Validate a taste-relative path; returns undefined for anything illegal. */
export function validateTasteRelativePath(relative: string): string | undefined {
  const normalized = relative.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (normalized === TASTE_FILE) return normalized;
  const match = /^([^/]+)\/taste\.md$/.exec(normalized);
  if (!match) return undefined;
  const category = match[1]!;
  if (category !== path.basename(category) || category.startsWith(".")) return undefined;
  return normalized;
}

export async function readTasteFile(cwd: string): Promise<string | undefined> {
  try {
    const content = await readFile(tasteFileFor(cwd), "utf8");
    return content.trim() ? content : undefined;
  } catch {
    return undefined;
  }
}

export function countLearnings(tasteContent: string): number {
  return tasteContent
    .split("\n")
    .filter((line) => LEARNING_ENTRY_RE.test(line)).length;
}

/** Sum learning bullets across every taste file in the directory. */
export async function countAllLearnings(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 2) return;
    for (const entry of await readdir(current).catch(() => [])) {
      const full = path.join(current, entry);
      if (entry.endsWith(".md")) {
        total += countLearnings(await readFile(full, "utf8").catch(() => ""));
      } else {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(dir, 0);
  return total;
}

export function userHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

interface LearnedLedger {
  version: 1;
  enabled: boolean;
  hashes: string[];
}

async function loadLedger(cwd: string): Promise<LearnedLedger> {
  try {
    const raw = await readFile(path.join(tasteDirFor(cwd), ".learned.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LearnedLedger>;
    return {
      version: 1,
      enabled: parsed.enabled !== false,
      hashes: Array.isArray(parsed.hashes) ? parsed.hashes.map(String).slice(-MAX_LEARNED_HASHES) : [],
    };
  } catch {
    return { version: 1, enabled: true, hashes: [] };
  }
}

async function saveLedger(cwd: string, ledger: LearnedLedger): Promise<void> {
  await mkdir(tasteDirFor(cwd), { recursive: true });
  await writeFile(
    path.join(tasteDirFor(cwd), ".learned.json"),
    `${JSON.stringify({ ...ledger, hashes: ledger.hashes.slice(-MAX_LEARNED_HASHES) }, null, 2)}\n`,
    "utf8",
  );
}

/** Genuine user prompt texts from an agent transcript, in order. */
export function extractUserTexts(
  messages: ReadonlyArray<{ role: unknown; content?: unknown }>,
): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = typeof message.content === "string"
      ? message.content
      : messageText(message.content);
    const trimmed = text.trim();
    if (!trimmed) continue;
    // Framework/meta injections, not user intent.
    if (trimmed.startsWith("<compacted_session_history>")) continue;
    if (trimmed.startsWith("[PLAN MODE")) continue;
    if (trimmed.startsWith("<system")) continue;
    texts.push(trimmed);
  }
  return texts;
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * The taste-learning agent prompt. The agent iterates with file tools over
 * the taste directory; every learning is a markdown bullet ending in a
 * confidence score. Design intent (original wording): durable and
 * generalizable preferences only; learn only from the NEW prompts; never
 * re-record; confidence may not move without fresh evidence; prefer amending
 * existing files; when nothing durable is new, make no tool calls and reply
 * "no changes".
 */
export function learnerSystemPrompt(): string {
  return [
    "You maintain the taste files for a coding agent: durable, generalizable",
    "preferences the user has expressed — coding style, tooling choices,",
    "workflow habits, and communication preferences. One-off task details are",
    "never taste.",
    "",
    "You will be given the current taste files and NEW user prompts from",
    "recent sessions. Update the files so they capture every NEW durable",
    "preference without losing or contradicting existing ones.",
    "",
    "Rules:",
    "- Learn only from the NEW prompts. They are the only evidence.",
    "- Do not re-record a preference that is already present. Seeing a similar",
    "  old bullet again is not new evidence.",
    "- Never raise or lower an existing bullet's Confidence unless a NEW prompt",
    "  is direct evidence for the change.",
    "- Each learning is one markdown bullet ending in a confidence score:",
    "  - Prefers tabs over spaces. Confidence: 0.9",
    "- Only record preferences that are explicit, repeated, or unambiguous.",
    "- Prefer amending existing files over creating near-duplicates; merge",
    "  near-duplicate bullets instead of adding them.",
    "- Keep every file under 8 KB.",
    "",
    "Use the tools to update the files. A taste path MUST be either",
    '"taste.md" (the root file) or "{category}/taste.md" (one category level)',
    "— never any other name or nesting:",
    "- write_taste_file to create or replace a file.",
    "- edit_taste_file to amend an existing file (first occurrence).",
    "- read_taste_file to inspect a file before editing.",
    "",
    'When the NEW prompts reveal nothing durable, make no tool calls and reply',
    'with exactly: no changes',
  ].join("\n");
}

/** Wire definitions for the three taste tools (typebox schemas). */
export function tasteToolDefinitions(): Tool[] {
  const pathProperty = Type.String({
    description: 'Path relative to the taste directory: "taste.md" or "{category}/taste.md".',
  });
  return [
    {
      name: "read_taste_file",
      description: "Read a taste file before editing it.",
      parameters: Type.Object({ path: pathProperty }),
    },
    {
      name: "write_taste_file",
      description: "Create or replace a taste file with the given markdown content.",
      parameters: Type.Object({
        path: pathProperty,
        content: Type.String({ description: "Full markdown content to write." }),
      }),
    },
    {
      name: "edit_taste_file",
      description: "Replace the first occurrence of old_text with new_text in a taste file.",
      parameters: Type.Object({
        path: pathProperty,
        old_text: Type.String({ description: "Exact existing text to replace." }),
        new_text: Type.String({ description: "Replacement text." }),
      }),
    },
  ];
}

interface ToolOutcome {
  text: string;
  isError: boolean;
  /** True when the tool modified (or created) a taste file. */
  mutated: boolean;
}

async function executeTasteTool(
  dir: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const readString = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" ? value : undefined;
  };
  const relative = readString("path");
  if (!relative) return { text: "error: path is required", isError: true, mutated: false };
  const validated = validateTasteRelativePath(relative);
  if (!validated) {
    return {
      text: 'error: taste path must be "taste.md" or "{category}/taste.md"',
      isError: true,
      mutated: false,
    };
  }
  const absolute = path.join(dir, validated);
  if (name === "read_taste_file") {
    try {
      return { text: await readFile(absolute, "utf8"), isError: false, mutated: false };
    } catch {
      return { text: "(file does not exist)", isError: false, mutated: false };
    }
  }
  if (name !== "write_taste_file" && name !== "edit_taste_file") {
    return { text: `error: unknown tool ${name}`, isError: true, mutated: false };
  }

  const before = await readFile(absolute, "utf8").catch(() => undefined);
  let next: string;
  if (name === "write_taste_file") {
    next = readString("content") ?? "";
  } else {
    if (before === undefined) {
      return { text: "error: file does not exist", isError: true, mutated: false };
    }
    const oldText = readString("old_text");
    const newText = readString("new_text");
    if (oldText === undefined || newText === undefined || !before.includes(oldText)) {
      return { text: "error: old_text not found", isError: true, mutated: false };
    }
    next = before.replace(oldText, newText);
  }
  if (Buffer.byteLength(next, "utf8") > MAX_TASTE_FILE_BYTES) {
    return {
      text: `error: taste file would exceed the ${MAX_TASTE_FILE_BYTES}-byte limit; merge near-duplicate bullets instead of adding more`,
      isError: true,
      mutated: false,
    };
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return { text: name === "write_taste_file" ? `wrote ${validated}` : `edited ${validated}`, isError: false, mutated: true };
}

export interface TasteLearningInput {
  models: Pick<Models, "complete">;
  model: Model<any>;
  cwd: string;
  /** Genuine user prompts not yet learned (already filtered by caller or ledger). */
  prompts: string[];
  signal?: AbortSignal | undefined;
}

export interface TasteLearningOutcome {
  updated: boolean;
  reason: "no-changes" | "learned" | "skipped-empty" | "rejected" | "disabled";
  entries: number;
  laneModelId?: string;
  /** Tool turns spent by the learning agent. */
  turns?: number;
}

interface TasteToolLoopInput {
  models: Pick<Models, "complete">;
  model: Model<any>;
  cwd: string;
  systemPrompt: string;
  userContent: string;
  signal?: AbortSignal | undefined;
}

/**
 * Shared taste tool-loop: the model iterates with the taste file tools over
 * the taste directory (up to LEARNING_MAX_TURNS) and commits changes directly.
 * If the final state has no valid learning bullets, the previous content is
 * restored.
 */
async function runTasteToolLoop(input: TasteToolLoopInput): Promise<TasteLearningOutcome> {
  const { models, model, cwd } = input;
  const dir = tasteDirFor(cwd);
  const before = (await readTasteFile(cwd)) ?? "";
  const messages: Message[] = [
    { role: "user", content: input.userContent, timestamp: Date.now() },
  ];
  const tools = tasteToolDefinitions();

  let mutated = false;
  let turns = 0;
  for (let turn = 0; turn < LEARNING_MAX_TURNS; turn += 1) {
    input.signal?.throwIfAborted();
    const assistant = await models.complete(
      model,
      { systemPrompt: input.systemPrompt, messages, tools },
      input.signal ? { signal: input.signal } : undefined,
    );
    messages.push(assistant);
    turns += 1;
    const toolCalls = assistant.content.filter(
      (block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
    );
    if (toolCalls.length === 0) break;
    for (const call of toolCalls) {
      const outcome = await executeTasteTool(dir, call.name, call.arguments ?? {});
      if (outcome.mutated) mutated = true;
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.isError,
        timestamp: Date.now(),
      });
    }
  }

  const entries = await countAllLearnings(dir);
  if (mutated && entries === 0) {
    // Invariant: a taste file always keeps at least one confidence-scored bullet.
    if (before) await writeFile(tasteFileFor(cwd), before, "utf8");
    else await rm(tasteFileFor(cwd)).catch(() => {});
    return { updated: false, reason: "rejected", entries: 0, turns };
  }
  if (!mutated) {
    return { updated: false, reason: "no-changes", entries: await countAllLearnings(dir), turns };
  }
  return { updated: true, reason: "learned", entries, turns };
}

/**
 * Run one learning pass from conversation prompts.
 */
export async function runTasteLearning(input: TasteLearningInput): Promise<TasteLearningOutcome> {
  const { cwd, prompts } = input;
  const digest = prompts.map((prompt, index) => `${index + 1}. ${oneLine(prompt, 400)}`).join("\n");
  return runTasteToolLoop({
    models: input.models,
    model: input.model,
    cwd,
    systemPrompt: learnerSystemPrompt(),
    userContent: [
      "Current taste files:",
      await existingSummary(tasteDirFor(cwd)),
      "",
      "NEW user prompts:",
      digest,
    ].join("\n"),
    signal: input.signal,
  });
}

function existingSummary(dir: string): string {
  // Built eagerly; the loop itself reads current content through the tools.
  try {
    const files: string[] = [];
    const walk = (current: string, depth: number): void => {
      if (depth > 2) return;
      for (const entry of require("node:fs").readdirSync(current)) {
        const full = path.join(current, entry);
        if (entry.endsWith(".md")) files.push(path.relative(dir, full).replaceAll("\\", "/"));
        else walk(full, depth + 1);
      }
    };
    walk(dir, 0);
    return files.length > 0
      ? files.map((file) => `- ${file}`).join("\n")
      : "(empty — this is the first learning pass)";
  } catch {
    return "(empty — this is the first learning pass)";
  }
}

function oneLine(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

export async function learnFromNewMessages(
  deps: {
    models: Pick<Models, "complete">;
    model: Model<any>;
  },
  cwd: string,
  messages: ReadonlyArray<{ role: unknown; content?: unknown }>,
  options?: { signal?: AbortSignal | undefined },
): Promise<TasteLearningOutcome & { considered: number }> {
  const ledger = await loadLedger(cwd);
  if (!ledger.enabled) {
    return { updated: false, reason: "disabled", entries: 0, considered: 0 };
  }
  const known = new Set(ledger.hashes);
  const fresh = extractUserTexts(messages).filter((text) => !known.has(userHash(text)));
  if (fresh.length === 0) {
    return { updated: false, reason: "skipped-empty", entries: 0, considered: 0 };
  }
  const batch = fresh.slice(-MAX_BATCH_MESSAGES);
  if (batch.join(" ").length < MIN_BATCH_CHARS) {
    return { updated: false, reason: "skipped-empty", entries: 0, considered: fresh.length };
  }

  try {
    const outcome = await runTasteLearning({
      models: deps.models,
      model: deps.model,
      cwd,
      prompts: batch,
      signal: options?.signal,
    });
    if (outcome.reason === "learned" || outcome.reason === "no-changes") {
      ledger.hashes.push(...batch.map(userHash));
      await saveLedger(cwd, ledger);
    }
    return { ...outcome, considered: fresh.length };
  } catch {
    // Learning is best-effort by design; never throw into the agent loop.
    return {
      updated: false,
      reason: "rejected",
      entries: countLearnings((await readTasteFile(cwd)) ?? ""),
      considered: fresh.length,
    };
  }
}

/** Enable/disable learning (persisted next to the taste files). */
export async function setTasteEnabled(cwd: string, enabled: boolean): Promise<void> {
  const ledger = await loadLedger(cwd);
  ledger.enabled = enabled;
  await saveLedger(cwd, ledger);
}

export async function isTasteEnabled(cwd: string): Promise<boolean> {
  return (await loadLedger(cwd)).enabled;
}

/** Remove all taste state (file + learned ledger) for the project. */
export async function clearTaste(cwd: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(tasteDirFor(cwd), { recursive: true, force: true });
}

/** Record prompt hashes without running a learning pass (used by imports that fail). */
export async function markLearned(cwd: string, prompts: readonly string[]): Promise<void> {
  const ledger = await loadLedger(cwd);
  ledger.hashes.push(...prompts.map(userHash));
  await saveLedger(cwd, ledger);
}

// ---------------------------------------------------------------------------
// Learning taste from an existing codebase
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh",
  ".ps1", ".sql", ".scala", ".lua",
]);
const SKIPPED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  "__pycache__", ".next", ".nuxt", ".venv", "venv", "deps", "_build",
]);
const MAX_SAMPLE_FILES = 60;
const MAX_SAMPLE_FILE_BYTES = 8_192;
const MAX_SAMPLE_TOTAL_CHARS = 96_000;

export interface CodeSample {
  relativePath: string;
  content: string;
  truncated: boolean;
}

/**
 * Deterministic, size-capped source sample from a repository: code extensions
 * only, dependency/build directories and hidden dirs skipped, per-file and
 * total budgets enforced. Sorted by path so the sample is stable.
 */
export async function collectCodeSamples(root: string): Promise<CodeSample[]> {
  const samples: CodeSample[] = [];
  let totalChars = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || samples.length >= MAX_SAMPLE_FILES || totalChars >= MAX_SAMPLE_TOTAL_CHARS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (samples.length >= MAX_SAMPLE_FILES || totalChars >= MAX_SAMPLE_TOTAL_CHARS) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await import("node:fs/promises").then((fs) => fs.stat(full)).catch(() => undefined);
      if (!stat || stat.size > MAX_SAMPLE_FILE_BYTES * 4) continue;
      let content = await readFile(full, "utf8").catch(() => undefined);
      if (content === undefined || content.includes("\0")) continue;
      const relativePath = path.relative(root, full).replaceAll("\\", "/");
      let truncated = false;
      if (content.length > MAX_SAMPLE_FILE_BYTES) {
        content = content.slice(0, MAX_SAMPLE_FILE_BYTES);
        truncated = true;
      }
      const budgetLeft = MAX_SAMPLE_TOTAL_CHARS - totalChars;
      if (content.length > budgetLeft) {
        content = content.slice(0, budgetLeft);
        truncated = true;
      }
      totalChars += content.length;
      samples.push({ relativePath, content, truncated });
    }
  };
  await walk(root, 0);
  return samples;
}

/** Render collected samples into the digest handed to the learning agent. */
export function renderCodeSamples(samples: readonly CodeSample[]): string {
  return samples
    .map((sample) =>
      [
        `### ${sample.relativePath}${sample.truncated ? " (truncated)" : ""}`,
        sample.content.trimEnd(),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The code-learning agent prompt: distill durable style conventions from the
 * sample code itself — naming, structure, testing and error-handling habits —
 * as taste bullets. Evidence-based only; original wording.
 */
export function codeLearnerSystemPrompt(): string {
  return [
    "You maintain the taste files for a coding agent. This pass learns from",
    "an existing codebase: the sample files below reveal how this user's",
    "projects are actually written. Extract the durable conventions a coding",
    "agent should follow when writing NEW code for them.",
    "",
    "Look for: naming style, module/file organization, error-handling and",
    "logging habits, testing approach, dependency and tooling choices,",
    "comment density, and formatting conventions that are consistent across",
    "files.",
    "",
    "Rules:",
    "- Every bullet must be evidence from the sample code. Do not invent",
    "  preferences, and do not restate generic best practices.",
    "- Only record conventions visible in more than one place, or unambiguous",
    "  in one (e.g. an explicit lint/format config).",
    "- Each learning is one markdown bullet ending in a confidence score:",
    "  - Uses vitest with colocated *.test.ts files. Confidence: 0.9",
    "- Keep bullets short and actionable for an agent writing new code.",
    "- You may organize into category files ({category}/taste.md) or use the",
    "  root taste.md; keep every file under 8 KB.",
    "",
    "Use the tools to update the files. A taste path MUST be either",
    '"taste.md" or "{category}/taste.md".',
    "",
    "When the sample reveals nothing durable and specific, make no tool calls",
    'and reply with exactly: no changes',
  ].join("\n");
}

export interface CodebaseTasteInput {
  models: Pick<Models, "complete">;
  model: Model<any>;
  cwd: string;
  /** Repository to learn conventions from (defaults to cwd). */
  repoDir: string;
  signal?: AbortSignal | undefined;
}

/**
 * Learn taste from a codebase: collect a deterministic sample, run the taste
 * tool loop with the code-learning prompt, and commit to this project's
 * taste files.
 */
export async function runCodebaseTasteLearning(
  input: CodebaseTasteInput,
): Promise<TasteLearningOutcome & { samples: number }> {
  const samples = await collectCodeSamples(input.repoDir);
  if (samples.length === 0) {
    return { updated: false, reason: "skipped-empty", entries: 0, samples: 0 };
  }
  const outcome = await runTasteToolLoop({
    models: input.models,
    model: input.model,
    cwd: input.cwd,
    systemPrompt: codeLearnerSystemPrompt(),
    userContent: [
      `Code samples from the repository at ${input.repoDir} (${samples.length} files, trimmed where marked):`,
      "",
      renderCodeSamples(samples),
    ].join("\n"),
    signal: input.signal,
  });
  return { ...outcome, samples: samples.length };
}
