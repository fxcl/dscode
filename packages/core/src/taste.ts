import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentText, type Message, type Model, type Models } from "@earendil-works/pi-ai";

/**
 * DSCode taste: durable, confidence-scored user preferences learned from
 * conversations, stored as markdown next to the project and injected into the
 * system prompt. Files live at <cwd>/.dscode/taste/ as either "taste.md" or
 * "<category>/taste.md" (one level of categories, nothing deeper).
 */

export const TASTE_DIR_NAME = path.join(".dscode", "taste");
export const TASTE_FILE = "taste.md";

/** A learning bullet must end in a confidence score. */
export const LEARNING_ENTRY_RE = /^- .*\bConfidence:\s*[0-9]+(?:\.[0-9]+)?\s*$/;

export const MAX_TASTE_FILE_BYTES = 16_384;
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
 * The taste-learning prompt. Contract: given the current taste file and NEW
 * user prompts, return either "no changes" or the complete updated taste file.
 * Every learning is a markdown bullet ending in "Confidence: <score>". Design
 * intent (original wording): durable and generalizable preferences only; never
 * re-record an existing preference; confidence may not move without fresh
 * evidence in the NEW prompts; prefer amending over near-duplicate files.
 */
export function learnerSystemPrompt(): string {
  return [
    "You maintain the taste file for a coding agent: durable, generalizable",
    "preferences the user has expressed — coding style, tooling choices,",
    "workflow habits, and communication preferences. One-off task details are",
    "never taste.",
    "",
    "You will receive the current taste file and NEW user prompts from recent",
    "sessions. Update the file so it captures every NEW durable preference",
    "without losing or contradicting existing ones.",
    "",
    "Rules:",
    "- Learn only from the NEW prompts. They are the only evidence.",
    "- Do not re-record a preference that is already present. Seeing a similar",
    "  old bullet is not new evidence.",
    "- Never raise or lower an existing bullet's Confidence unless a NEW prompt",
    "  is direct evidence for the change.",
    "- Each learning is one markdown bullet ending in a confidence score:",
    "  - Prefers tabs over spaces. Confidence: 0.9",
    "- Only record preferences that are explicit, repeated, or unambiguous.",
    "- Keep the file small: merge near-duplicates instead of adding bullets.",
    "- Keep the file under 8 KB.",
    "",
    'Reply with the complete updated file contents. If nothing durable is new,',
    'reply with exactly: no changes',
  ].join("\n");
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
}

/** Run one learning pass over the given prompts and persist the updated file. */
export async function runTasteLearning(input: TasteLearningInput): Promise<TasteLearningOutcome> {
  const { models, model, cwd, prompts } = input;
  const existing = (await readTasteFile(cwd)) ?? "";
  const digest = prompts.map((prompt, index) => `${index + 1}. ${oneLine(prompt, 400)}`).join("\n");
  const userMessage: Message = {
    role: "user",
    content: [
      "Current taste file:",
      existing.trim() || "(empty — this is the first learning pass)",
      "",
      "NEW user prompts:",
      digest,
    ].join("\n"),
    timestamp: Date.now(),
  };

  const response = await models.complete(model, {
    systemPrompt: learnerSystemPrompt(),
    messages: [userMessage],
  }, input.signal ? { signal: input.signal } : undefined);
  const reply = extractReply(response.content).trim();

  if (!reply || /^no changes\.?$/i.test(reply)) {
    return { updated: false, reason: "no-changes", entries: countLearnings(existing) };
  }
  const entries = countLearnings(reply);
  if (entries === 0) {
    return { updated: false, reason: "rejected", entries: countLearnings(existing) };
  }
  if (Buffer.byteLength(reply, "utf8") > MAX_TASTE_FILE_BYTES) {
    return { updated: false, reason: "rejected", entries: countLearnings(existing) };
  }

  await mkdir(tasteDirFor(cwd), { recursive: true });
  await writeFile(tasteFileFor(cwd), `${reply.trimEnd()}\n`, "utf8");
  return { updated: true, reason: "learned", entries };
}

function extractReply(content: unknown): string {
  return typeof content === "string" ? content : contentText(content as never);
}

function oneLine(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

/**
 * Pick prompts that have not been learned yet (ledger-backed), run a learning
 * pass over them, and record their hashes on success — including "no changes",
 * so a prompt is never re-mined unless learning failed outright.
 */
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
