import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderToolCall } from "./tool-ui.js";

/**
 * Sleep tool: wait WITHOUT holding a shell process. Fills the gap the
 * foreground-sleep guard created (batch 15 blocks `sleep` commands) between
 * write_stdin's blind yield windows and schedule_wakeup's 60s minimum: a
 * model that must pause 30s for a deploy or a rate limit gets one tool call
 * instead of a shell process or a polling loop.
 *
 * Per-call caps are self-explaining: a capped result names the remaining
 * time so the model can call sleep again. Every wake-up costs an API round
 * trip, and the description says so - fewer, longer sleeps beat rapid
 * polling. Design follows the documented command-code sleep mechanism; all
 * wording is original. wake_on_input is NOT ported: the pi runtime exposes
 * no pending-input probe; Esc interruption still works via the abort signal.
 */

export const MAX_SLEEP_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 1_000;

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1_000;
  if (totalSeconds < 60) {
    const rounded = Math.round(totalSeconds * 10) / 10;
    return `${rounded}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Parse an "until" value: an ISO-8601 timestamp, or a local "HH:MM[:SS]"
 * wall-clock time whose next occurrence is used (a time already past today
 * means tomorrow). undefined when unparseable.
 */
export function parseUntil(until: string, now: number): number | undefined {
  const text = until.trim();
  const wallClock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (wallClock) {
    const hours = Number(wallClock[1]);
    const minutes = Number(wallClock[2]);
    const seconds = Number(wallClock[3] ?? "0");
    if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
    const target = new Date(now);
    target.setHours(hours, minutes, seconds, 0);
    let delta = target.getTime() - now;
    if (delta < 0) delta += 86_400_000;
    return delta;
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - now);
}

export interface SleepDurationResolution {
  requestedMs: number;
  effectiveMs: number;
  clamp: "none" | "max-capped";
}

/** Clamp the requested sleep to the per-call maximum, recording why. */
export function resolveSleepDuration(requestedMs: number, maxMs = MAX_SLEEP_MS): SleepDurationResolution {
  if (requestedMs > maxMs) {
    return { requestedMs, effectiveMs: maxMs, clamp: "max-capped" };
  }
  return { requestedMs, effectiveMs: requestedMs, clamp: "none" };
}

export type SleepEnd = "completed" | "interrupted";

/** Result text that states what happened and any cap applied. */
export function describeSleepOutcome(outcome: {
  end: SleepEnd;
  sleptMs: number;
  resolved: SleepDurationResolution;
}): string {
  const lines: string[] = [];
  if (outcome.end === "completed") {
    lines.push(`Slept for ${formatDurationMs(outcome.sleptMs)}.`);
  } else {
    lines.push(`Sleep interrupted by the user after ${formatDurationMs(outcome.sleptMs)}.`);
  }
  if (outcome.resolved.clamp === "max-capped" && outcome.end === "completed") {
    const remaining = outcome.resolved.requestedMs - outcome.sleptMs;
    lines.push(
      `Note: the requested ${formatDurationMs(outcome.resolved.requestedMs)} was capped at the maximum sleep duration per call (${formatDurationMs(outcome.resolved.effectiveMs)}). Call sleep again to keep waiting (${formatDurationMs(Math.max(0, remaining))} remaining).`,
    );
  }
  return lines.join("\n");
}

export const sleepParameters = Type.Object({
  seconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description: "How long to sleep, in seconds (fractional allowed, e.g. 0.5). Required unless until is set.",
    }),
  ),
  until: Type.Optional(
    Type.String({
      description:
        'Sleep until a point in time instead: an ISO-8601 timestamp ("2026-07-11T14:30:00Z") or a local "HH:MM"/"HH:MM:SS" (next occurrence - a time already past today means tomorrow). Required unless seconds is set.',
    }),
  ),
  reason: Type.Optional(
    Type.String({ description: "Short note (5-10 words) about what you are waiting for, shown while sleeping." }),
  ),
});

/** Register the model-callable sleep tool. */
export function registerSleepTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    description:
      "Wait for a duration or until a point in time WITHOUT holding a shell process. Use it when you are waiting for something external to finish or become ready (a deploy, CI, a rate limit, a scheduled time). Prefer this over exec_command with `sleep` (blocked in the foreground) and over write_stdin polling: it holds no process, streams progress, and can be interrupted. You can call it concurrently with other tools. Provide exactly one of seconds or until. Long waits are capped per call; a capped result names the remaining time so you can call sleep again. Each wake-up costs an API round trip - prefer fewer, longer sleeps over rapid polling.",
    promptSnippet: "sleep: pause without holding a shell process (deploys, rate limits, scheduled times)",
    promptGuidelines: [
      "Use sleep instead of a foreground `sleep` command; combine with write_stdin(wait) when a background process is involved.",
      "Prefer fewer, longer sleeps over rapid polling - every wake-up costs an API round trip.",
    ],
    parameters: sleepParameters,
    renderShell: "self" as const,
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate) {
      const hasSeconds = typeof params.seconds === "number" && Number.isFinite(params.seconds);
      const hasUntil = typeof params.until === "string" && params.until.trim() !== "";
      if (hasSeconds === hasUntil) {
        return {
          content: [{ type: "text", text: "sleep: provide exactly one of seconds or until, not both or neither." }],
          details: {},
          isError: true,
        };
      }
      let requestedMs: number;
      if (hasSeconds) {
        const seconds = params.seconds as number;
        if (seconds < 0) {
          return {
            content: [{ type: "text", text: `sleep: seconds must be a non-negative number, got ${String(params.seconds)}` }],
            details: {},
            isError: true,
          };
        }
        requestedMs = seconds * 1_000;
      } else {
        const parsed = parseUntil(params.until as string, Date.now());
        if (parsed === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `sleep: could not parse until "${String(params.until)}" - use an ISO-8601 timestamp or "HH:MM"/"HH:MM:SS"`,
              },
            ],
            details: {},
            isError: true,
          };
        }
        requestedMs = parsed;
      }
      const reason = typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason.trim() : undefined;
      const resolved = resolveSleepDuration(requestedMs);
      let sleptMs = 0;
      let end: SleepEnd = "completed";
      while (sleptMs < resolved.effectiveMs) {
        if (signal?.aborted) {
          end = "interrupted";
          break;
        }
        const slice = Math.min(PROGRESS_INTERVAL_MS, resolved.effectiveMs - sleptMs);
        const interrupted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), slice);
          timer.unref?.();
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true },
          );
        });
        sleptMs += slice;
        if (interrupted) {
          end = "interrupted";
          break;
        }
        if (sleptMs < resolved.effectiveMs) {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Sleeping - ${formatDurationMs(sleptMs)} / ${formatDurationMs(resolved.effectiveMs)}${reason ? ` - ${reason}` : ""}`,
              },
            ],
            details: { end: "sleeping", sleptMs, requestedMs: resolved.requestedMs, effectiveMs: resolved.effectiveMs },
          });
        }
      }
      return {
        content: [{ type: "text", text: describeSleepOutcome({ end, sleptMs, resolved }) }],
        details: { end, sleptMs, requestedMs: resolved.requestedMs, effectiveMs: resolved.effectiveMs },
      };
    },
    renderCall(args, theme, context) {
      const label =
        typeof args.until === "string" && args.until.trim() !== ""
          ? `until ${args.until.trim()}`
          : `${String(args.seconds ?? "?")}s`;
      return renderToolCall("Sleep", label, theme, context);
    },
  });
}
