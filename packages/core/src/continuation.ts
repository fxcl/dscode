/**
 * Continuation recovery: three bounded auto-continuations for turns that ended
 * without the model meaning to stop — an empty reply, a reply truncated by the
 * output length limit, and a reply that announces work it never started
 * ("Now I'll run the tests:"). Counters are per kind; any run that actually
 * used tools resets the progress-sensitive counters, so recovery never fights
 * real progress. Failure notices distinguish thinking-only from fully empty.
 * Design follows the documented command-code continuation mechanism; all
 * wording is original.
 */

export const MAX_EMPTY_CONTINUATIONS = 2;
export const MAX_LENGTH_CONTINUATIONS = 3;
export const MAX_INTENT_CONTINUATIONS = 2;

/**
 * First line of the message the turn arbiter sends when a stop hook asks for
 * continuation. Shared constant so the injected-input filter below and the
 * sender can never drift apart again (a past bug: filter checked a bracketed
 * variant the sender never emitted).
 */
export const STOP_HOOK_CONTINUATION_HEAD = "A project stop hook asked DSCode to keep going after the previous turn.";

/**
 * Text prefixes of turns DSCode injects itself (loop continuations, stop-hook
 * reasons, wakeups, monitor pings, recovery nudges, verifier overrides).
 * A real user input resets recovery budgets and rewind checkpoints; an
 * injected turn must never be mistaken for one. Exported as the single
 * source of truth shared by the extension's input pipeline.
 */
export const INJECTED_INPUT_PREFIXES: readonly string[] = [
  "[goal loop", // loop continuation AND verifier override
  STOP_HOOK_CONTINUATION_HEAD, // stop-hook continuation message
  "[self-scheduled wakeup",
  "[monitor ping",
  "[continuation]",
];

export function isInjectedInput(text: string): boolean {
  return INJECTED_INPUT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export type ContinuationKind = "empty" | "length" | "intent";

export interface ContinuationState {
  empty: number;
  length: number;
  intent: number;
}

export function initialContinuationState(): ContinuationState {
  return { empty: 0, length: 0, intent: 0 };
}

export interface ContinuationTurn {
  /** Final assistant text of the run that just ended. */
  finalText: string;
  /** Stop reason of the final assistant message ("stop" | "length" | ...). */
  stopReason: string | undefined;
  /** Whether the final assistant message carries a thinking block. */
  hadThinking: boolean;
  /** Whether the run executed at least one tool call (evidence of progress). */
  hadToolCalls: boolean;
}

/**
 * Stop reasons that must never trigger recovery. "error" runs are owned by
 * the run-error feedback loop (the failure is prepended to the user's next
 * input); "aborted" runs are the user's explicit intent. The source system
 * never saw these here because its provider ran inside the loop where the
 * retry layer and cancel paths intercepted them before this stage.
 */
const NON_RECOVERABLE_STOP_REASONS = new Set(["error", "aborted"]);

export interface ContinuationDecision {
  kind: ContinuationKind;
  attempt: number;
  maxAttempts: number;
  /** The follow-up input to send. */
  input: string;
}

export interface ContinuationOutcome {
  decision?: ContinuationDecision | undefined;
  /** Set when a kind exhausted its budget; carries the user-facing hint. */
  exhausted?: { kind: ContinuationKind; message: string } | undefined;
}

const EMPTY_CONTINUE_INPUT =
  "[continuation] Your previous reply was empty. Continue with the task now. If you are missing information, state precisely what is missing in one sentence — do not reply with only a question mark or nothing.";
const LENGTH_CONTINUE_INPUT =
  "[continuation] Your previous message was cut off by the output length limit. Continue exactly where it stopped — do not repeat text you already sent. If the remaining content is large, continue in compact form (summaries, diffs, or pointers) instead of full verbatim text.";
const INTENT_CONTINUE_INPUT =
  "[continuation] Your previous message announced a next action but did not carry it out. Perform that action now with the appropriate tool, or say explicitly why you are not proceeding.";

const EMPTY_EXHAUSTED_HINT =
  "The model replied empty several times in a row. If a thinking trace appeared without output, the model may be stuck reasoning — try a shorter prompt, a different model, or restate the task.";
const LENGTH_EXHAUSTED_HINT =
  "The model hit the output length limit several times without finishing. Ask for a smaller deliverable (one file or section at a time) or lower the scope of the request.";
const INTENT_EXHAUSTED_HINT =
  "The model repeatedly announced work without performing it. Restate the task with an explicit first action, or switch models.";

/** Strip markdown fence edges and horizontal rules from a candidate sentence. */
function stripMarkdownEdges(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```\s*$/, "")
    .replace(/^---+\s*$/, "")
    .trim();
}

/**
 * Heuristic for a turn whose last sentence announces an action that never
 * happened: the text ends on a colon, or its final segment opens with a
 * forward-looking construction ("I'll now…", "Let's…", "Next, …") or a
 * progressive verb ("Running…", "Creating…").
 */
export function endsWithDanglingIntent(rawText: string): boolean {
  const text = rawText.replace(/['']/g, "'").trim();
  if (!text) return false;
  if (/:\s*$/.test(text)) return true;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const last = stripMarkdownEdges(sentences.at(-1) ?? "");
  if (!last || last.endsWith("?")) return false;
  if (/^(?:and|or|but|so)\b/i.test(last)) return false;
  const segments = last.split(/[:;]\s+|\s+[—–-]\s+|[—–]/);
  const tail = stripMarkdownEdges(segments.at(-1) ?? "");
  return /(?:(?:i|we)\s+(?:'ll|will|'m going to|am going to|would)|let's|(?:next|now|first|then|finally)[, ]|(?:i|we)\s+(?:'ll|will|am|are)?\s*(?:start|begin)|running|creating|writing|updating|checking|testing|starting|installing|building|implementing|refactoring|fixing|adding|removing)\b/i.test(tail);
}

/**
 * Decide whether the finished turn warrants a bounded automatic continuation.
 * Pure: callers own the state object across turns.
 */
export function provideContinuation(state: ContinuationState, turn: ContinuationTurn): ContinuationOutcome {
  if (turn.hadToolCalls) {
    // Progress was made; recovery counters restart so each new phase of work
    // gets a fresh budget instead of inheriting a spent one. This holds even
    // when the run itself ended on a non-recoverable stop reason.
    state.length = 0;
    state.intent = 0;
  }
  if (turn.stopReason !== undefined && NON_RECOVERABLE_STOP_REASONS.has(turn.stopReason)) {
    return {};
  }
  const hasVisibleText = turn.finalText.trim().length > 0;
  if (hasVisibleText) {
    state.empty = 0;
    if (turn.stopReason === "length") {
      if (state.length >= MAX_LENGTH_CONTINUATIONS) {
        return { decision: undefined, exhausted: { kind: "length", message: LENGTH_EXHAUSTED_HINT } };
      }
      state.length += 1;
      return { decision: { kind: "length", attempt: state.length, maxAttempts: MAX_LENGTH_CONTINUATIONS, input: LENGTH_CONTINUE_INPUT } };
    }
    if (endsWithDanglingIntent(turn.finalText)) {
      if (state.intent >= MAX_INTENT_CONTINUATIONS) {
        return { decision: undefined, exhausted: { kind: "intent", message: INTENT_EXHAUSTED_HINT } };
      }
      state.intent += 1;
      return { decision: { kind: "intent", attempt: state.intent, maxAttempts: MAX_INTENT_CONTINUATIONS, input: INTENT_CONTINUE_INPUT } };
    }
    return {};
  }
  if (state.empty >= MAX_EMPTY_CONTINUATIONS) {
    return {
      decision: undefined,
      exhausted: {
        kind: "empty",
        message: turn.hadThinking
          ? `The model replied empty ${MAX_EMPTY_CONTINUATIONS + 1} times in a row (thinking without output). ${EMPTY_EXHAUSTED_HINT}`
          : `The model replied empty ${MAX_EMPTY_CONTINUATIONS + 1} times in a row. ${EMPTY_EXHAUSTED_HINT}`,
      },
    };
  }
  state.empty += 1;
  return { decision: { kind: "empty", attempt: state.empty, maxAttempts: MAX_EMPTY_CONTINUATIONS, input: EMPTY_CONTINUE_INPUT } };
}
