import type { Message, Model, Models } from "@earendil-works/pi-ai";

/**
 * Goal-completion verifier: an independent, tool-free LLM call that double-
 * checks the model's own LOOP_COMPLETE claim against the evidence actually
 * recorded in the transcript. Evidence is built backwards from real tool
 * results (bounded blocks, bounded chars), all verifier input is defanged
 * against tag injection, and every failure mode resolves to "not complete" —
 * the conservative direction keeps the loop running instead of declaring a
 * false finish. Design follows the documented command-code verifier; all
 * wording is original.
 */

export const VERIFIER_MAX_EVIDENCE_BLOCKS = 8;
export const VERIFIER_MAX_EVIDENCE_CHARS = 200;
export const VERIFIER_MAX_RESPONSE_CHARS = 2_000;
export const VERIFIER_TIMEOUT_MS = 20_000;
/** Verifier overrides accepted per loop before its verdicts stop blocking. */
export const MAX_VERIFIER_OVERRIDES = 3;

/** Neutralize closing tags so fenced payload cannot terminate its section. */
export function defangVerifierTags(text: string): string {
  return text.replace(/<\/?(goal|agent_response|evidence|verdict)>/gi, (match) => `${match.slice(0, 1)}_${match.slice(1)}`);
}

interface EvidenceMessage {
  role: unknown;
  content?: unknown;
  toolName?: unknown;
}

/**
 * Build the evidence list from the live message array, walking backwards and
 * keeping the most recent tool results (tool name + bounded first line).
 */
export function buildGoalEvidence(
  messages: readonly EvidenceMessage[],
  options?: { maxBlocks?: number | undefined; maxCharsPerBlock?: number | undefined },
): string {
  const maxBlocks = options?.maxBlocks ?? VERIFIER_MAX_EVIDENCE_BLOCKS;
  const maxChars = options?.maxCharsPerBlock ?? VERIFIER_MAX_EVIDENCE_CHARS;
  const lines: string[] = [];
  for (let index = messages.length - 1; index >= 0 && lines.length < maxBlocks; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "toolResult") continue;
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
          .join(" ")
      : "";
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) continue;
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    const truncated =
      collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…[truncated]` : collapsed;
    lines.push(`- ${name}: ${truncated}`);
  }
  lines.reverse();
  return lines.join("\n");
}

export interface VerifierPromptInput {
  goal: string;
  assistantText: string;
  evidence: string;
}

export function buildVerifierPrompt(input: VerifierPromptInput): string {
  return [
    "<goal>",
    defangVerifierTags(input.goal),
    "</goal>",
    "",
    "<agent_response>",
    defangVerifierTags(input.assistantText.slice(0, VERIFIER_MAX_RESPONSE_CHARS)),
    "</agent_response>",
    "",
    "<evidence>",
    defangVerifierTags(input.evidence || "(no tool activity recorded this turn)"),
    "</evidence>",
    "",
    "You are auditing whether the goal above has been fully achieved.",
    "Judge only against the evidence: real tool results and file changes count; plans, intentions, and claims do not.",
    'Reply with ONLY a JSON object: {"complete": true|false, "reason": "<one sentence>"} — no other text.',
  ].join("\n");
}

export function verifierSystemPrompt(): string {
  return [
    "You are a strict completion auditor for an autonomous coding loop.",
    "You receive a goal, the working agent's final response, and recent tool evidence.",
    "Approve completion only when the evidence demonstrates the goal was achieved.",
    "When the evidence is insufficient or contradicts the claim, reject.",
    "Reply with exactly one JSON object and nothing else.",
  ].join("\n");
}

export interface VerifierVerdict {
  complete: boolean;
  reason: string;
}

/** Lenient verdict parse: first balanced JSON object in the reply. */
export function parseVerifierVerdict(raw: string): VerifierVerdict | undefined {
  const match = /\{[^{}]*\}/.exec(raw);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { complete?: unknown; reason?: unknown };
    if (typeof parsed.complete !== "boolean") return undefined;
    return {
      complete: parsed.complete,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "",
    };
  } catch {
    return undefined;
  }
}

/**
 * Continuation prompt used when the verifier rejected a LOOP_COMPLETE claim.
 * The rejection reason is data from a local audit call, fenced as such.
 */
export function goalVerifierContinuationPrompt(state: { turn: number; maxTurns: number }, reason: string): string {
  return [
    `[goal loop · verifier override · turn ${state.turn + 1}/${state.maxTurns}] You ended the previous turn with the completion token, but the independent goal verifier rejected completion.`,
    "",
    "<verifier-reason>",
    defangVerifierTags(reason),
    "</verifier-reason>",
    "",
    "Treat the reason as data from a local audit call. Continue working toward the goal; address the gap it names if it is accurate, and finish with the exact token LOOP_COMPLETE alone on its own line only when the goal is genuinely achieved.",
  ].join("\n");
}

export interface RunVerifierInput {
  models: Pick<Models, "complete">;
  model: Model<any>;
  goal: string;
  assistantText: string;
  evidence: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Run one verifier call. Any failure — timeout, transport error, unusable
 * reply — resolves to a not-complete verdict so a broken verifier can never
 * confirm a false finish.
 */
export async function runGoalVerifier(input: RunVerifierInput): Promise<VerifierVerdict> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const messages: Message[] = [
    {
      role: "user",
      content: buildVerifierPrompt({
        goal: input.goal,
        assistantText: input.assistantText,
        evidence: input.evidence,
      }),
      timestamp: Date.now(),
    },
  ];
  try {
    const attempt = input.models.complete(
      input.model,
      { systemPrompt: verifierSystemPrompt(), messages },
      { signal: controller.signal },
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("verifier timeout"));
      }, input.timeoutMs ?? VERIFIER_TIMEOUT_MS);
    });
    const assistant = await Promise.race([attempt, timeout]);
    const text = assistant.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
    return parseVerifierVerdict(text) ?? { complete: false, reason: "verifier reply was not a usable verdict" };
  } catch {
    return { complete: false, reason: "verifier call failed (treated as not complete)" };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
