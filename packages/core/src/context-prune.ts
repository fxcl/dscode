import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "./guardrails.js";

/**
 * Pre-compaction prune tier: before the (expensive) full summarization kicks
 * in, slim tool results that have aged out of the recent window. Implemented
 * as a per-request projection over the `context` event, so the stored session
 * transcript is never touched — pruning is recomputed every request and
 * disappears as soon as context usage drops (e.g. after a compaction).
 */

/** Context ratio at which pruning activates. */
export const PRE_TRIM_AT = 0.8;
/** Context ratio at which pruning deactivates again (hysteresis). */
export const PRE_TRIM_RESET_AT = 0.7;
/** The most recent tool results always stay intact. */
export const KEEP_RECENT_TOOL_RESULTS = 10;

function isToolResult(message: AgentMessage): boolean {
  return (
    (message as { role?: unknown }).role === "toolResult" &&
    Array.isArray((message as { content?: unknown }).content)
  );
}

function textLength(content: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      total += (block as { text: string }).text.length;
    }
  }
  return total;
}

/**
 * Return messages with all but the most recent `keepRecent` tool results
 * replaced by one-line stubs. Returns the input array unchanged when there is
 * nothing to prune. The last tool results — the ones the current turn most
 * likely depends on — are never touched.
 */
export function pruneOldToolResults(
  messages: readonly AgentMessage[],
  keepRecent: number = KEEP_RECENT_TOOL_RESULTS,
): AgentMessage[] {
  let recentCount = 0;
  let pruned = 0;
  const output: AgentMessage[] = new Array(messages.length);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!isToolResult(message)) {
      output[index] = message;
      continue;
    }
    recentCount += 1;
    if (recentCount <= keepRecent) {
      output[index] = message;
      continue;
    }
    const toolName =
      typeof (message as { toolName?: unknown }).toolName === "string"
        ? (message as { toolName: string }).toolName
        : "tool";
    const tokens = Math.ceil(textLength((message as { content: unknown[] }).content) / 4);
    output[index] = {
      ...message,
      content: [
        {
          type: "text",
          text: `[pruned] ${toolName} output (~${tokens.toLocaleString()} tokens) withheld from older context; re-run the tool if this exact output is needed.`,
        },
      ],
    } as AgentMessage;
    pruned += 1;
  }
  return pruned > 0 ? output : (messages as AgentMessage[]);
}
