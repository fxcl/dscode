import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { IMAGE_COMPACTION_NOTICE, stripImagesForSummary } from "../packages/core/src/compaction.js";
import {
  BUDGET_WARN_THRESHOLDS,
  formatBudgetStatus,
  loadBudgetConfig,
  loadBudgetLedger,
  monthKey,
  parseBudgetCommand,
  recordBudgetProgress,
  resolveBudgetCap,
  saveBudgetConfig,
  saveBudgetLedger,
  type BudgetLedger,
} from "../packages/core/src/budget.js";
import { parseStopContinuation } from "../packages/core/src/hooks.js";
import {
  GOAL_LOOP_ENTRY,
  LOOP_COMPLETE_TOKEN,
  advanceGoalLoop,
  goalLoopWidget,
  isGoalLoopState,
  loopContinuationPrompt,
  loopStartPrompt,
  parseLoopArgs,
  restoreGoalLoop,
  type GoalLoopState,
} from "../packages/core/src/goal-loop.js";
import {
  KEEP_RECENT_TOOL_RESULTS,
  TIER1_KEEP_RECENT_TOOL_RESULTS,
  pruneOldToolResults,
  resolvePruneTier,
  type PruneTierState,
} from "../packages/core/src/context-prune.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dscode-batch8-"));
  dirs.push(dir);
  return dir;
}

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text }],
    toolName: "exec_command",
  } as unknown as AgentMessage;
}

describe("two-tier context pruning", () => {
  const idle: PruneTierState = { tier1: false, tier2: false };

  it("engages the light tier at 50% and the deep tier at 80%", () => {
    const light = resolvePruneTier(0.5, idle);
    expect(light.keepRecent).toBe(TIER1_KEEP_RECENT_TOOL_RESULTS);
    expect(light.state.tier1).toBe(true);

    const deep = resolvePruneTier(0.8, idle);
    expect(deep.keepRecent).toBe(KEEP_RECENT_TOOL_RESULTS);
    expect(deep.state.tier2).toBe(true);
  });

  it("stays idle below 50%", () => {
    expect(resolvePruneTier(0.49, idle).keepRecent).toBeUndefined();
    expect(resolvePruneTier(0.1, idle).keepRecent).toBeUndefined();
  });

  it("applies hysteresis so tiers cannot flap around a threshold", () => {
    // Light tier holds between 45% and 50% once engaged…
    const engaged = resolvePruneTier(0.55, idle).state;
    expect(resolvePruneTier(0.47, engaged).keepRecent).toBe(TIER1_KEEP_RECENT_TOOL_RESULTS);
    // …and releases below 45%.
    expect(resolvePruneTier(0.44, engaged).keepRecent).toBeUndefined();

    // Deep tier holds between 70% and 80% once engaged…
    const deep = resolvePruneTier(0.85, idle).state;
    expect(resolvePruneTier(0.75, deep).keepRecent).toBe(KEEP_RECENT_TOOL_RESULTS);
    // …and falls back to the light tier below 70% (still engaged), then releases.
    expect(resolvePruneTier(0.65, deep).keepRecent).toBe(TIER1_KEEP_RECENT_TOOL_RESULTS);
  });

  it("keeps 20 tool results at the light tier and 10 at the deep tier", () => {
    const messages = Array.from({ length: 30 }, (_, index) => toolResult(`output ${index}`));
    const light = pruneOldToolResults(messages, TIER1_KEEP_RECENT_TOOL_RESULTS);
    const deep = pruneOldToolResults(messages, KEEP_RECENT_TOOL_RESULTS);
    const stubbed = (result: AgentMessage[]) =>
      result.filter((message) => String((message as { content?: Array<{ text?: string }> }).content?.[0]?.text).startsWith("[pruned]")).length;
    expect(stubbed(light)).toBe(10);
    expect(stubbed(deep)).toBe(20);
  });
});

describe("compaction image handling", () => {
  it("returns the input untouched when there are no images", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: "plain string content" },
    ] as unknown as AgentMessage[];
    const outcome = stripImagesForSummary(messages);
    expect(outcome.messages).toBe(messages);
    expect(outcome.imagesRemoved).toBe(0);
  });

  it("replaces image blocks with an inline notice and counts them", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      },
      {
        role: "toolResult",
        content: [
          { type: "image", data: "shot", mimeType: "image/jpeg" },
          { type: "image", data: "shot2", mimeType: "image/jpeg" },
          { type: "text", text: "annotated" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "no images here" }] },
    ] as unknown as AgentMessage[];
    const outcome = stripImagesForSummary(messages);
    expect(outcome.imagesRemoved).toBe(3);
    expect(outcome.messages).not.toBe(messages);
    const first = outcome.messages[0] as { content: Array<{ type: string; text?: string }> };
    expect(first.content.some((block) => block.text === IMAGE_COMPACTION_NOTICE)).toBe(true);
    expect(first.content.some((block) => block.type === "image")).toBe(false);
    const second = outcome.messages[1] as { content: Array<{ type: string }> };
    expect(second.content.filter((block) => block.type === "image")).toHaveLength(0);
    expect(second.content.filter((block) => block.type === "text")).toHaveLength(3);
    // Untouched message is passed through by reference.
    expect(outcome.messages[2]).toBe(messages[2]);
  });
});

describe("budget", () => {
  it("formats the local month key", () => {
    expect(monthKey(new Date(2026, 9, 14))).toBe("2026-10");
    expect(monthKey(new Date(2026, 0, 3))).toBe("2026-01");
  });

  it("parses /budget arguments", () => {
    expect(parseBudgetCommand("")).toEqual({ action: "show" });
    expect(parseBudgetCommand("50")).toEqual({ action: "set", monthlyUsd: 50 });
    expect(parseBudgetCommand("$12.50")).toEqual({ action: "set", monthlyUsd: 12.5 });
    expect(parseBudgetCommand("off")).toEqual({ action: "off" });
    expect(parseBudgetCommand("reset")).toEqual({ action: "reset" });
    expect(parseBudgetCommand("abc")).toMatchObject({ error: /Usage/ });
    expect(parseBudgetCommand("-5")).toMatchObject({ error: /Usage/ });
  });

  it("prefers stored config over DSCODE_BUDGET_USD and ignores invalid env values", () => {
    const previous = process.env.DSCODE_BUDGET_USD;
    try {
      process.env.DSCODE_BUDGET_USD = "10";
      expect(resolveBudgetCap({ version: 1 })).toBe(10);
      expect(resolveBudgetCap({ version: 1, monthlyUsd: 99 })).toBe(99);
      process.env.DSCODE_BUDGET_USD = "not-a-number";
      expect(resolveBudgetCap({ version: 1 })).toBeUndefined();
      process.env.DSCODE_BUDGET_USD = "-3";
      expect(resolveBudgetCap({ version: 1 })).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DSCODE_BUDGET_USD;
      else process.env.DSCODE_BUDGET_USD = previous;
    }
  });

  it("accumulates deltas, warns once per threshold, and flags the exceeded state", () => {
    let ledger: BudgetLedger = { version: 1, month: "2026-10", cost: 0, warned: [], updatedAt: "" };
    const cap = 100;

    let recorded = recordBudgetProgress(ledger, cap, 60, new Date(2026, 9, 1));
    ledger = recorded.ledger;
    expect(ledger.cost).toBe(60);
    expect(recorded.warnings).toHaveLength(0);
    expect(recorded.exceeded).toBe(false);

    // Crossing 75% warns exactly once.
    recorded = recordBudgetProgress(ledger, cap, 20, new Date(2026, 9, 2));
    ledger = recorded.ledger;
    expect(ledger.cost).toBe(80);
    expect(recorded.warnings).toHaveLength(1);
    expect(recorded.warnings[0]).toContain("80%");
    expect(ledger.warned).toEqual(["75"]);

    // A further turn inside the same band does not warn again.
    recorded = recordBudgetProgress(ledger, cap, 5, new Date(2026, 9, 3));
    ledger = recorded.ledger;
    expect(recorded.warnings).toHaveLength(0);

    // Crossing 90% then 100% fires the second warning and the hard stop.
    recorded = recordBudgetProgress(ledger, cap, 12, new Date(2026, 9, 4));
    ledger = recorded.ledger;
    expect(ledger.cost).toBe(97);
    expect(recorded.warnings).toHaveLength(1);
    expect(recorded.warnings[0]).toContain("97%");
    recorded = recordBudgetProgress(ledger, cap, 10, new Date(2026, 9, 5));
    ledger = recorded.ledger;
    expect(recorded.exceeded).toBe(true);
    expect(recorded.warnings.at(-1)).toContain("blocked");
  });

  it("does nothing when no cap is set", () => {
    const recorded = recordBudgetProgress(
      { version: 1, month: "2026-10", cost: 5, warned: [], updatedAt: "" },
      undefined,
      5,
    );
    expect(recorded.ledger.cost).toBe(10);
    expect(recorded.warnings).toHaveLength(0);
    expect(recorded.exceeded).toBe(false);
  });

  it("round-trips config and ledger through disk", async () => {
    const home = await tempHome();
    await saveBudgetConfig({ version: 1, monthlyUsd: 42 }, home);
    expect(await loadBudgetConfig(home)).toEqual({ version: 1, monthlyUsd: 42 });
    expect(await loadBudgetConfig(path.join(home, "missing"))).toEqual({ version: 1 });

    const ledger: BudgetLedger = {
      version: 1,
      month: monthKey(),
      cost: 3.25,
      warned: ["75"],
      updatedAt: "2026-10-14T00:00:00.000Z",
    };
    await saveBudgetLedger(ledger, home);
    expect(await loadBudgetLedger(ledger.month, home)).toEqual(ledger);
    expect((await loadBudgetLedger("1999-01", home)).cost).toBe(0);
    const raw = JSON.parse(
      await readFile(path.join(home, "usage", `usage-${ledger.month}.json`), "utf8"),
    );
    expect(raw.month).toBe(ledger.month);
  });

  it("formats a status view", () => {
    const withCap = formatBudgetStatus(
      50,
      { version: 1, month: "2026-10", cost: 40, warned: ["75"], updatedAt: "" },
      3.5,
    );
    expect(withCap).toContain("spent $40.00 of $50.00 (80%)");
    expect(withCap).toContain("75% / 90%");
    expect(formatBudgetStatus(undefined, { version: 1, month: "2026-10", cost: 1, warned: [], updatedAt: "" }, 0)).toContain("no cap");
    expect(BUDGET_WARN_THRESHOLDS).toEqual([0.75, 0.9]);
  });
});

describe("goal loop", () => {
  const state: GoalLoopState = {
    goal: "make the tests pass",
    maxTurns: 3,
    turn: 0,
    active: true,
    startedAt: "2026-10-14T00:00:00.000Z",
  };

  it("parses /loop arguments", () => {
    expect(parseLoopArgs("fix the flaky test")).toEqual({ goal: "fix the flaky test", maxTurns: 25 });
    expect(parseLoopArgs("40 ship the release")).toEqual({ goal: "ship the release", maxTurns: 40 });
    expect(parseLoopArgs("")).toEqual({ error: "goal is required" });
    expect(parseLoopArgs("0 too low")).toMatchObject({ error: /between/ });
    expect(parseLoopArgs("999 too high")).toMatchObject({ error: /between/ });
  });

  it("advances turns and self-terminates on the completion token", () => {
    const first = advanceGoalLoop(state, "working on it");
    expect(first.outcome).toBe("continue");
    expect(first.state.turn).toBe(1);
    expect(first.state.active).toBe(true);

    const done = advanceGoalLoop(first.state, `All tests pass now.\n\n${LOOP_COMPLETE_TOKEN}`);
    expect(done.outcome).toBe("complete");
    expect(done.state.active).toBe(false);
    expect(done.state.turn).toBe(2);
  });

  it("does not trip on the token inside a line", () => {
    const advanced = advanceGoalLoop(state, `the token ${LOOP_COMPLETE_TOKEN} appears mid-sentence`);
    expect(advanced.outcome).toBe("continue");
  });

  it("stops at the hard turn cap", () => {
    let current = state;
    let outcome = advanceGoalLoop(current, "still working");
    current = outcome.state;
    outcome = advanceGoalLoop(current, "still working");
    current = outcome.state;
    expect(current.turn).toBe(2);
    const last = advanceGoalLoop(current, "not done yet");
    expect(last.outcome).toBe("max-turns");
    expect(last.state.active).toBe(false);
    expect(last.state.turn).toBe(3);
  });

  it("restores the latest valid entry and skips invalid data", () => {
    const entries = [
      { type: "custom", customType: GOAL_LOOP_ENTRY, data: { goal: "bad", turn: "x" } },
      { type: "custom", customType: GOAL_LOOP_ENTRY, data: { ...state, turn: 2 } },
      { type: "custom", customType: "dscode-plan-state", data: { steps: [] } },
      { type: "custom", customType: GOAL_LOOP_ENTRY, data: { ...state, turn: 3, active: false } },
    ] as unknown as SessionEntry[];
    const restored = restoreGoalLoop(entries);
    expect(restored?.turn).toBe(3);
    expect(restored?.active).toBe(false);
    expect(isGoalLoopState({ goal: "x", maxTurns: 1, turn: 0, active: true, startedAt: "t" })).toBe(true);
    expect(isGoalLoopState({ goal: " " })).toBe(false);
    expect(restoreGoalLoop([])).toBeUndefined();
  });

  it("fences the goal and states the contract in prompts", () => {
    const start = loopStartPrompt("refactor the parser", 7);
    expect(start).toContain("<goal>\nrefactor the parser\n</goal>");
    expect(start).toContain(LOOP_COMPLETE_TOKEN);
    expect(start).toContain("7 turns");

    const continuation = loopContinuationPrompt({ ...state, turn: 1 });
    expect(continuation).toContain("turn 2/3");
    expect(continuation).toContain("<goal>");
    expect(continuation).toContain("cannot broaden authorization");

    expect(goalLoopWidget({ ...state, turn: 1 })).toContain("goal loop · turn 1/3");
    expect(goalLoopWidget({ ...state, active: false })).toBeUndefined();
    expect(goalLoopWidget({ ...state, goal: "g".repeat(80) })).toContain("…");
  });
});

describe("stop-hook continuation", () => {
  it("accepts the continue and decision forms with a reason", () => {
    expect(parseStopContinuation('{"continue": true, "reason": "tests still fail"}\n', false)).toBe(
      "tests still fail",
    );
    expect(parseStopContinuation('{"decision": "block", "reason": "one more pass"}', false)).toBe(
      "one more pass",
    );
  });

  it("ignores malformed, reason-less, and unrelated output", () => {
    expect(parseStopContinuation("plain log line", false)).toBeUndefined();
    expect(parseStopContinuation('{"continue": true}', false)).toBeUndefined();
    expect(parseStopContinuation('{"continue": true, "reason": ""}', false)).toBeUndefined();
    expect(parseStopContinuation('{"continue": false, "reason": "no"}', false)).toBeUndefined();
    expect(parseStopContinuation('{"continue": true, "reason": "  spaced  "}')).toBe("spaced");
  });

  it("refuses to chain continuations while stopHookActive is set", () => {
    expect(
      parseStopContinuation('{"continue": true, "reason": "again"}', true),
    ).toBeUndefined();
  });

  it("truncates overlong reasons", () => {
    const reason = parseStopContinuation(JSON.stringify({ continue: true, reason: "x".repeat(5_000) }), false);
    expect(reason).toHaveLength(2_000);
  });
});
