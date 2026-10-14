import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "./guardrails.js";

/**
 * Pre-compaction prune tier: before the (expensive) full summarization kicks
 * in, slim tool results that have aged out of the recent window. Implemented
 * as a per-request projection over the `context` event, so the stored session
 * transcript is never touched — pruning is recomputed every request and
 * disappears as soon as context usage drops (e.g. after a compaction).
 */

/** Context ratio at which the light tier activates. */
export const TIER1_PRUNE_AT = 0.5;/** Context ratio at which the light tier deactivates again (hysteresis). */
export const TIER1_PRUNE_RESET_AT = 0.45;
/** Tool results kept intact by the light tier. */
export const TIER1_KEEP_RECENT_TOOL_RESULTS = 20;
/** Context ratio at which the deep tier activates. */
export const PRE_TRIM_AT = 0.8;
/** Context ratio at which the deep tier deactivates again (hysteresis). */
export const PRE_TRIM_RESET_AT = 0.7;
/** The most recent tool results always stay intact (deep tier). */
export const KEEP_RECENT_TOOL_RESULTS = 10;

export interface PruneTierState {
  tier1: boolean;
  tier2: boolean;
}

/**
 * Two-tier pre-compaction pruning. Both tiers engage with hysteresis so the
 * projection cannot flap around a threshold: the light tier (keep 20) engages
 * at 50% usage and releases below 45%; the deep tier (keep 10) engages at 80%
 * and releases below 70%. The deep tier wins while both are engaged.
 */
export function resolvePruneTier(
  ratio: number,
  state: PruneTierState,
): { state: PruneTierState; keepRecent?: number } {
  const next: PruneTierState = { ...state };
  if (ratio >= PRE_TRIM_AT) next.tier2 = true;
  else if (ratio < PRE_TRIM_RESET_AT) next.tier2 = false;
  if (ratio >= TIER1_PRUNE_AT) next.tier1 = true;
  else if (ratio < TIER1_PRUNE_RESET_AT) next.tier1 = false;
  if (next.tier2) return { state: next, keepRecent: KEEP_RECENT_TOOL_RESULTS };
  if (next.tier1) return { state: next, keepRecent: TIER1_KEEP_RECENT_TOOL_RESULTS };
  return { state: next };
}

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

/** Messages above which a fresh-session nudge fires (secondary tip). */
export const SECONDARY_TIP_MIN_MESSAGES = 50;/** Images in context above which the image-weight tip fires. */
export const SECONDARY_TIP_MIN_IMAGES = 3;
/** Documentation constant: approximate tokens one in-context image costs. */
export const IMAGE_TOKEN_ESTIMATE = 1_500;

/**
 * Secondary context tips, shown alongside the prune/compaction nudges once
 * usage has reached the light tier: session length and image weight. Returns
 * stable keys (for once-per-session dedup) and at most one line each; empty
 * when there is nothing worth saying.
 */
export function secondaryContextTips(
  ratio: number,
  messageCount: number,
  imageCount: number,
): Array<{ key: string; text: string }> {
  if (ratio < TIER1_PRUNE_AT) return [];
  const tips: Array<{ key: string; text: string }> = [];
  if (messageCount > SECONDARY_TIP_MIN_MESSAGES) {
    tips.push({
      key: "secondary-messages",
      text: `Context carries ${messageCount} messages — after this task, consider a fresh session (old tool outputs are already pruned from requests, but the transcript keeps growing).`,
    });
  }
  if (imageCount >= SECONDARY_TIP_MIN_IMAGES) {
    tips.push({
      key: "secondary-images",
      text: `${imageCount} images in context (~${IMAGE_TOKEN_ESTIMATE.toLocaleString()} tokens each) — drop screenshots you no longer need before the full compaction.`,
    });
  }
  return tips;
}

/** Synthetic result text for a tool call that never produced a result. */
export const ORPHAN_TOOL_RESULT_TEXT =
  "No result — the tool call did not complete (interrupted or lost).";

interface ToolCallLike {
  type?: unknown;
  id?: unknown;
  name?: unknown;
}

function assistantToolCalls(message: AgentMessage): Array<{ id: string; name: string }> {
  const content = (message as { role?: unknown; content?: unknown }).content;
  if ((message as { role?: unknown }).role !== "assistant" || !Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string }> = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as ToolCallLike).type === "toolCall" &&
      typeof (block as ToolCallLike).id === "string" &&
      typeof (block as ToolCallLike).name === "string"
    ) {
      calls.push({ id: (block as ToolCallLike).id as string, name: (block as ToolCallLike).name as string });
    }
  }
  return calls;
}

/**
 * Send-time repair for orphaned tool calls: after an interrupt or a rewind,
 * an assistant toolCall can persist without its toolResult, which makes the
 * request payload invalid for strict providers. This per-request projection
 * appends a synthetic "did not complete" result after each orphaned call.
 * The stored transcript is never touched.
 */
export function repairOrphanToolResults(messages: readonly AgentMessage[]): AgentMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if ((message as { role?: unknown }).role !== "toolResult") continue;
    const id = (message as { toolCallId?: unknown }).toolCallId;
    if (typeof id === "string") answered.add(id);
  }

  let changed = false;
  const output: AgentMessage[] = [];
  for (const message of messages) {
    output.push(message);
    for (const call of assistantToolCalls(message)) {
      if (answered.has(call.id)) continue;
      changed = true;
      output.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: ORPHAN_TOOL_RESULT_TEXT }],
        timestamp: Date.now(),
      } as AgentMessage);
    }
  }
  return changed ? output : (messages as AgentMessage[]);
}
