import { describe, expect, it } from "vitest";
import { mechanicalDigestSummary } from "../packages/core/src/compaction.js";
import {
  endsWithDanglingIntent,
  initialContinuationState,
  isInjectedInput,
  MAX_EMPTY_CONTINUATIONS,
  MAX_INTENT_CONTINUATIONS,
  MAX_LENGTH_CONTINUATIONS,
  provideContinuation,
  STOP_HOOK_CONTINUATION_HEAD,
} from "../packages/core/src/continuation.js";
import {
  buildDeferredToolsSection,
  DEFERRED_MCP_TOOL_THRESHOLD,
  describeToolAlias,
  renderSchemaType,
  renderToolSignature,
  SEARCH_TOOLS_DEFAULT_RESULTS,
  searchDeferredTools,
  type DeferredToolEntry,
} from "../packages/core/src/deferred-tools.js";
import {
  buildGoalEvidence,
  defangVerifierTags,
  goalVerifierContinuationPrompt,
  parseVerifierVerdict,
  runGoalVerifier,
  verifierSystemPrompt,
} from "../packages/core/src/goal-verifier.js";
import { planUpdateNotes, type PlanState } from "../packages/core/src/plan.js";
import { createRereadGuard, REREAD_NOTICE_THRESHOLD } from "../packages/core/src/reread-guard.js";
import {
  buildMonitorWakeupPrompt,
  buildSelfWakeupPrompt,
  MAX_WAKEUP_CHAIN,
  MAX_WAKEUP_DELAY_SECONDS,
  planScheduleWakeup,
} from "../packages/core/src/self-wakeup.js";
import {
  guardFetchUrl,
  isBlockedIPv4,
  isBlockedIPv6,
  isPrivateOrLocalHost,
} from "../packages/core/src/ssrf-guard.js";

function planState(steps: Array<[string, "pending" | "in_progress" | "completed"]>): PlanState {
  return {
    steps: steps.map(([step, status]) => ({ step, status })),
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("batch 17 — plan update guardrails", () => {
  it("warns when the submitted plan is identical to the current one", () => {
    const previous = planState([["Write tests", "in_progress"], ["Run tests", "pending"]]);
    const next = planState([["Write tests", "in_progress"], ["Run tests", "pending"]]);
    const notes = planUpdateNotes(previous, next);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("identical");
    expect(notes[0]).toContain("update_plan again");
  });

  it("treats case and whitespace differences as the same step", () => {
    const previous = planState([["Run the tests", "pending"]]);
    const next = planState([["  run   the tests ", "pending"]]);
    expect(planUpdateNotes(previous, next)[0]).toContain("identical");
  });

  it("warns when unfinished steps were silently dropped", () => {
    const previous = planState([
      ["Refactor parser", "completed"],
      ["Add integration test", "in_progress"],
      ["Update docs", "pending"],
    ]);
    const next = planState([["Refactor parser", "completed"]]);
    const notes = planUpdateNotes(previous, next);
    const droppedNote = notes.find((note) => note.includes("REMOVED"));
    expect(droppedNote).toBeDefined();
    expect(droppedNote).toContain("Add integration test");
    expect(droppedNote).toContain("Update docs");
    expect(droppedNote).toContain("ENTIRE plan");
  });

  it("does not warn about completed steps disappearing", () => {
    const previous = planState([["Old step", "completed"], ["Current", "in_progress"]]);
    const next = planState([["Current", "in_progress"]]);
    expect(planUpdateNotes(previous, next).some((note) => note.includes("REMOVED"))).toBe(false);
  });

  it("caps the dropped-step preview at five entries", () => {
    const previous = planState(Array.from({ length: 8 }, (_, index) => [`Step ${index}`, "pending"] as [string, "pending"]));
    const next = planState([]);
    const droppedNote = planUpdateNotes(previous, next).find((note) => note.includes("REMOVED"));
    expect(droppedNote).toContain("Step 0");
    expect(droppedNote).toContain("Step 4");
    expect(droppedNote).not.toContain("Step 5");
    expect(droppedNote).toContain("8 unfinished steps");
  });

  it("requires a verification step before a plan may close out", () => {
    const previous = planState([["Edit files", "in_progress"], ["Tidy up", "in_progress"]]);
    const next = planState([["Edit files", "completed"], ["Tidy up", "completed"]]);
    const notes = planUpdateNotes(previous, next);
    expect(notes.some((note) => note.includes("verification step"))).toBe(true);
  });

  it("accepts a plan that closed out with a verification step", () => {
    const previous = planState([["Edit files", "in_progress"], ["Run the test suite", "pending"]]);
    const next = planState([["Edit files", "completed"], ["Run the test suite", "completed"]]);
    expect(planUpdateNotes(previous, next).some((note) => note.includes("verification step"))).toBe(false);
  });

  it("never notes a verification gap for an unfinished plan", () => {
    const previous = planState([["Edit files", "in_progress"]]);
    const next = planState([["Edit files", "completed"]]);
    // A single-step plan that is completed: still asks for verification.
    expect(planUpdateNotes(previous, next).some((note) => note.includes("verification step"))).toBe(true);
    const stillOpen = planState([["Edit files", "in_progress"]]);
    expect(planUpdateNotes(next, stillOpen).some((note) => note.includes("verification step"))).toBe(false);
  });

  it("stays silent without a previous plan", () => {
    const next = planState([["First step", "in_progress"]]);
    expect(planUpdateNotes(undefined, next)).toEqual([]);
  });
});

describe("batch 17 — mechanical compaction fallback", () => {
  it("keeps user prompts, assistant intents, and tool names", () => {
    const messages = [
      { role: "user", content: "Fix the failing parser test", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "Looking at the parser now." },
          { type: "toolCall", id: "1", name: "read_file", arguments: { path: "src/parser.ts" } },
        ],
        stopReason: "toolUse",
        usage: {},
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-chat",
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "1", toolName: "read_file", content: [{ type: "text", text: "x".repeat(5_000) }], timestamp: 3 },
    ];
    const digest = mechanicalDigestSummary(messages as never);
    expect(digest).toContain("Fix the failing parser test");
    expect(digest).toContain("Looking at the parser now.");
    expect(digest).toContain("assistant used read_file(src/parser.ts)");
    expect(digest).toContain("tool output was dropped");
    expect(digest).not.toContain("xxxxx");
  });

  it("reads text blocks out of array-shaped user content", () => {
    const digest = mechanicalDigestSummary([
      { role: "user", content: [{ type: "text", text: "Check CI" }, { type: "image", data: "…" }], timestamp: 1 },
    ] as never);
    expect(digest).toContain("Check CI");
  });

  it("omits tool output entirely", () => {
    const digest = mechanicalDigestSummary([
      { role: "toolResult", toolCallId: "9", toolName: "exec_command", content: [{ type: "text", text: "SECRET-OUTPUT" }], timestamp: 1 },
    ] as never);
    expect(digest).not.toContain("SECRET-OUTPUT");
  });

  it("bounds the digest and says so when truncating", () => {
    const messages = Array.from({ length: 600 }, (_, index) => ({
      role: "user",
      content: `user message number ${index}`,
      timestamp: index,
    }));
    const digest = mechanicalDigestSummary(messages as never);
    expect(digest).toContain("older entries omitted");
    expect(digest.split("\n").length).toBeLessThanOrEqual(410);
  });

  it("returns a labeled digest for an empty history", () => {
    const digest = mechanicalDigestSummary([]);
    expect(digest).toContain("Mechanical fallback digest");
  });
});

describe("batch 17 — continuation recovery", () => {
  it("continues an empty reply up to the cap, then reports exhaustion", () => {
    const state = initialContinuationState();
    for (let attempt = 1; attempt <= MAX_EMPTY_CONTINUATIONS; attempt += 1) {
      const outcome = provideContinuation(state, { finalText: "", stopReason: "stop", hadThinking: false, hadToolCalls: false });
      expect(outcome.decision?.kind).toBe("empty");
      expect(outcome.decision?.attempt).toBe(attempt);
    }
    const exhausted = provideContinuation(state, { finalText: "", stopReason: "stop", hadThinking: false, hadToolCalls: false });
    expect(exhausted.decision).toBeUndefined();
    expect(exhausted.exhausted?.kind).toBe("empty");
  });

  it("distinguishes thinking-without-output in the exhaustion hint", () => {
    const state = initialContinuationState();
    let last: ReturnType<typeof provideContinuation> | undefined;
    for (let index = 0; index <= MAX_EMPTY_CONTINUATIONS; index += 1) {
      last = provideContinuation(state, { finalText: "", stopReason: "stop", hadThinking: true, hadToolCalls: false });
    }
    expect(last?.exhausted?.message).toContain("thinking without output");
  });

  it("never recovers error or aborted runs - they are owned by other loops", () => {
    const state = initialContinuationState();
    for (const stopReason of ["error", "aborted"]) {
      for (let index = 0; index < 5; index += 1) {
        const outcome = provideContinuation(state, { finalText: "", stopReason, hadThinking: false, hadToolCalls: false });
        expect(outcome, `${stopReason} #${index}`).toEqual({});
      }
    }
    // The empty budget must survive untouched for a later genuine empty reply.
    const genuine = provideContinuation(state, { finalText: "", stopReason: "stop", hadThinking: false, hadToolCalls: false });
    expect(genuine.decision?.kind).toBe("empty");
    expect(genuine.decision?.attempt).toBe(1);
  });

  it("still resets progress counters on a tool-using run that aborted", () => {
    const state = initialContinuationState();
    provideContinuation(state, { finalText: "x".repeat(10), stopReason: "length", hadThinking: false, hadToolCalls: false });
    expect(state.length).toBe(1);
    provideContinuation(state, { finalText: "partial", stopReason: "aborted", hadThinking: false, hadToolCalls: true });
    expect(state.length).toBe(0);
  });

  it("continues a length-truncated reply up to the cap", () => {
    const state = initialContinuationState();
    for (let attempt = 1; attempt <= MAX_LENGTH_CONTINUATIONS; attempt += 1) {
      const outcome = provideContinuation(state, { finalText: "partial output", stopReason: "length", hadThinking: false, hadToolCalls: false });
      expect(outcome.decision?.kind).toBe("length");
      expect(outcome.decision?.attempt).toBe(attempt);
    }
    expect(
      provideContinuation(state, { finalText: "partial output", stopReason: "length", hadThinking: false, hadToolCalls: false }).exhausted?.kind,
    ).toBe("length");
  });

  it("resets progress-sensitive counters after real tool work", () => {
    const state = initialContinuationState();
    provideContinuation(state, { finalText: "partial", stopReason: "length", hadThinking: false, hadToolCalls: false });
    provideContinuation(state, { finalText: "all done", stopReason: "stop", hadThinking: false, hadToolCalls: true });
    expect(state.length).toBe(0);
    expect(state.intent).toBe(0);
  });

  it("clears the empty counter once visible text arrives", () => {
    const state = initialContinuationState();
    provideContinuation(state, { finalText: "", stopReason: "stop", hadThinking: false, hadToolCalls: false });
    provideContinuation(state, { finalText: "A normal reply.", stopReason: "stop", hadThinking: false, hadToolCalls: false });
    expect(state.empty).toBe(0);
  });

  it("stays silent on a normal completed turn", () => {
    const state = initialContinuationState();
    const outcome = provideContinuation(state, {
      finalText: "Implemented the fix and the tests pass.",
      stopReason: "stop",
      hadThinking: false,
      hadToolCalls: true,
    });
    expect(outcome).toEqual({});
  });

  it("recognizes announced-but-not-started intents", () => {
    for (const text of [
      "That looks right. Now I'll run the test suite:",
      "Let me check the configuration next:",
      "Next, updating the docs.",
      "Running the migration.",
    ]) {
      expect(endsWithDanglingIntent(text), text).toBe(true);
    }
  });

  it("does not flag questions, finished statements, or empty text", () => {
    for (const text of [
      "",
      "   ",
      "Shall I apply this change?",
      "The change is applied and tests pass.",
      "and that should finish the job",
    ]) {
      expect(endsWithDanglingIntent(text), text).toBe(false);
    }
  });

  it("bounds intent recovery independently", () => {
    const state = initialContinuationState();
    for (let attempt = 1; attempt <= MAX_INTENT_CONTINUATIONS; attempt += 1) {
      const outcome = provideContinuation(state, {
        finalText: "Now I'll run the tests:",
        stopReason: "stop",
        hadThinking: false,
        hadToolCalls: false,
      });
      expect(outcome.decision?.kind).toBe("intent");
      expect(outcome.decision?.attempt).toBe(attempt);
    }
    expect(
      provideContinuation(state, {
        finalText: "Now I'll run the tests:",
        stopReason: "stop",
        hadThinking: false,
        hadToolCalls: false,
      }).exhausted?.kind,
    ).toBe("intent");
  });

  it("prefers length recovery over intent recovery for a truncated announcement", () => {
    const state = initialContinuationState();
    const outcome = provideContinuation(state, {
      finalText: "Now I'll run the tests:",
      stopReason: "length",
      hadThinking: false,
      hadToolCalls: false,
    });
    expect(outcome.decision?.kind).toBe("length");
  });

  it("survives curly-quote normalization", () => {
    expect(endsWithDanglingIntent("Let’s verify the build:")).toBe(true);
  });
});

describe("batch 17 — injected-input identification", () => {
  it("recognizes the actual stop-hook continuation first line", () => {
    // Regression: the filter once checked a bracketed variant the sender never
    // emitted, so stop-hook turns were treated as user input. Both sides now
    // share the STOP_HOOK_CONTINUATION_HEAD constant; this pins the contract.
    expect(isInjectedInput(STOP_HOOK_CONTINUATION_HEAD)).toBe(true);
    expect(isInjectedInput(`${STOP_HOOK_CONTINUATION_HEAD}\nrest of the message`)).toBe(true);
    expect(isInjectedInput("[A project stop hook asked ...")).toBe(false);
  });

  it("recognizes every message shape the extension injects", () => {
    for (const text of [
      "[goal loop · turn 3/25] The loop is still active. Continue working toward the goal below.",
      "[goal loop · verifier override · turn 4/10] You ended the previous turn with the completion token.",
      "[self-scheduled wakeup · check 2] The check-in you scheduled has come due.",
      "[monitor ping] Background process p1 is still running (started npm run build).",
      "[continuation] Your previous reply was empty. Continue with the task now.",
    ]) {
      expect(isInjectedInput(text), text).toBe(true);
    }
  });

  it("treats real user text as user input", () => {
    expect(isInjectedInput("fix the failing parser test")).toBe(false);
    expect(isInjectedInput("please run the loop script once")).toBe(false);
    expect(isInjectedInput("")).toBe(false);
  });
});

describe("batch 17 — deferred tools", () => {
  const catalog: DeferredToolEntry[] = [
    {
      name: "mcp__fs__create_directory",
      description: "Create a directory, including parents. Fails when the path exists.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, recursive: { type: "boolean" } },
        required: ["path"],
      },
    },
    {
      name: "mcp__db__query",
      description: "Run a read-only SQL query against the warehouse.",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" }, limit: { type: "integer" } },
        required: ["sql"],
      },
    },
    { name: "mcp__fs__stat", description: "Stat a path.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  ];

  it("renders optional fields with a question mark and keeps required fields plain", () => {
    const signature = renderToolSignature(catalog[0]!);
    expect(signature).toContain("- mcp__fs__create_directory{path: string, recursive?: boolean}:");
  });

  it("renders arrays, unions, and enums", () => {
    expect(renderSchemaType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(renderSchemaType({ enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(renderSchemaType({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
  });

  it("keeps the description to its first sentence", () => {
    expect(renderToolSignature(catalog[0]!)).toContain("Create a directory, including parents.");
    expect(renderToolSignature(catalog[0]!)).not.toContain("Fails when the path exists");
  });

  it("falls back to a name-only signature when no schema exists", () => {
    expect(renderToolSignature({ name: "bare", description: "No schema.", inputSchema: undefined })).toBe("- bare: No schema.");
  });

  it("truncates oversized signatures at a field boundary", () => {
    const manyFields: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) manyFields[`field${index}`] = { type: "string" };
    const signature = renderToolSignature({ name: "wide", description: "Wide.", inputSchema: { type: "object", properties: manyFields } });
    expect(signature).toContain(", …}");
    expect(signature.length).toBeLessThan(700);
  });

  it("builds a system-prompt section that explains the notation and the lookup rule", () => {
    const section = buildDeferredToolsSection(catalog);
    expect(section).toContain("You HAVE the 3 tools below");
    expect(section).toContain("WRITTEN AS A TYPESCRIPT OBJECT TYPE");
    expect(section).toContain("call the tool directly — no lookup");
    expect(section).toContain("look the tool up before retrying");
    // Sorted by tool name.
    expect(section.indexOf("mcp__db__query")).toBeLessThan(section.indexOf("mcp__fs__create_directory"));
  });

  it("returns an empty section for an empty catalog", () => {
    expect(buildDeferredToolsSection([])).toBe("");
  });

  it("matches by capability description", () => {
    const hits = searchDeferredTools(catalog, "run a sql query");
    expect(hits[0]?.name).toBe("mcp__db__query");
  });

  it("prefers name matches over description matches", () => {
    const hits = searchDeferredTools(catalog, "stat");
    expect(hits[0]?.name).toBe("mcp__fs__stat");
  });

  it("loads exact names through select:", () => {
    const hits = searchDeferredTools(catalog, "select:mcp__fs__stat,mcp__db__query");
    expect(hits.map((hit) => hit.name)).toEqual(["mcp__fs__stat", "mcp__db__query"]);
  });

  it("ignores select: names that are already active", () => {
    const active = new Set(["mcp__fs__stat"]);
    const hits = searchDeferredTools(catalog, "select:mcp__fs__stat,mcp__db__query", {
      isDeferred: (name) => !active.has(name),
    });
    expect(hits.map((hit) => hit.name)).toEqual(["mcp__db__query"]);
  });

  it("honors max_results and its clamp", () => {
    expect(searchDeferredTools(catalog, "path", { maxResults: 1 })).toHaveLength(1);
    expect(searchDeferredTools(catalog, "path", { maxResults: 999 })).toHaveLength(2);
    // Only two of the three tools mention "path"; the default result cap
    // cannot manufacture matches that the query did not produce.
    expect(searchDeferredTools(catalog, "path")).toHaveLength(2);
    expect(searchDeferredTools(catalog, "a b c d e f g h", { maxResults: SEARCH_TOOLS_DEFAULT_RESULTS })).toHaveLength(0);
  });

  it("returns nothing for an empty query", () => {
    expect(searchDeferredTools(catalog, "   ")).toEqual([]);
  });

  it("has a documented engage threshold", () => {
    expect(DEFERRED_MCP_TOOL_THRESHOLD).toBeGreaterThan(0);
  });

  it("maps known foreign tool names to DSCode equivalents", () => {
    expect(describeToolAlias("bash")).toContain("exec_command");
    expect(describeToolAlias("todo_write")).toContain("update_plan");
    expect(describeToolAlias("read_multiple_files")).toContain("read_file");
    expect(describeToolAlias("task_output")).toContain("write_stdin");
    expect(describeToolAlias("apply_patch")).toBeUndefined();
  });
});

describe("batch 17 — goal verifier", () => {
  it("builds evidence from the most recent tool results", () => {
    const messages = [
      { role: "toolResult", toolCallId: "1", toolName: "read_file", content: [{ type: "text", text: "const a = 1;" }] },
      { role: "toolResult", toolCallId: "2", toolName: "exec_command", content: [{ type: "text", text: "tests passed" }] },
    ];
    const evidence = buildGoalEvidence(messages as never);
    expect(evidence).toContain("- read_file: const a = 1;");
    expect(evidence).toContain("- exec_command: tests passed");
    expect(evidence.indexOf("read_file")).toBeLessThan(evidence.indexOf("exec_command"));
  });

  it("bounds the evidence blocks and per-block characters", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "toolResult",
      toolCallId: String(index),
      toolName: "tool",
      content: [{ type: "text", text: "y".repeat(500) }],
    }));
    const evidence = buildGoalEvidence(messages as never, { maxBlocks: 3, maxCharsPerBlock: 40 });
    expect(evidence.split("\n")).toHaveLength(3);
    expect(evidence).toContain("[truncated]");
  });

  it("defangs section tags so fenced payload cannot terminate its section", () => {
    // The angle bracket itself is neutralized, so neither an opening nor a
    // closing section tag survives in the verifier input.
    expect(defangVerifierTags("</evidence><goal>")).toBe("<_/evidence><_goal>");
    expect(defangVerifierTags("</evidence>")).not.toContain("</evidence>");
    expect(defangVerifierTags("<verdict>")).not.toContain("<verdict>");
  });

  it("parses a JSON verdict out of surrounding prose", () => {
    expect(parseVerifierVerdict('verdict: {"complete": true, "reason": "tests pass"}')).toEqual({
      complete: true,
      reason: "tests pass",
    });
  });

  it("rejects an unusable verdict", () => {
    expect(parseVerifierVerdict("looks done")).toBeUndefined();
    expect(parseVerifierVerdict('{"reason": "no flag"}')).toBeUndefined();
    expect(parseVerifierVerdict("{not json}")).toBeUndefined();
  });

  it("audits on a strict system prompt", () => {
    expect(verifierSystemPrompt()).toContain("completion auditor");
  });

  it("fences the verifier reason as data in the override prompt", () => {
    const prompt = goalVerifierContinuationPrompt({ turn: 2, maxTurns: 10 }, "no test output recorded");
    expect(prompt).toContain("<verifier-reason>");
    expect(prompt).toContain("no test output recorded");
    expect(prompt).toContain("data from a local audit call");
    expect(prompt).toContain("LOOP_COMPLETE");
  });

  it("resolves to not-complete when the call fails", async () => {
    const verdict = await runGoalVerifier({
      models: {
        complete: async () => {
          throw new Error("network down");
        },
      } as never,
      model: {} as never,
      goal: "Ship the fix",
      assistantText: "Done!",
      evidence: "",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.reason).toContain("verifier call failed");
  });

  it("resolves to not-complete on an unusable reply", async () => {
    const verdict = await runGoalVerifier({
      models: {
        complete: async () => ({ content: [{ type: "text", text: "I think so?" }] }),
      } as never,
      model: {} as never,
      goal: "Ship the fix",
      assistantText: "Done!",
      evidence: "",
    });
    expect(verdict.complete).toBe(false);
  });

  it("accepts a valid verdict", async () => {
    const verdict = await runGoalVerifier({
      models: {
        complete: async () => ({ content: [{ type: "text", text: '{"complete": true, "reason": "suite green"}' }] }),
      } as never,
      model: {} as never,
      goal: "Ship the fix",
      assistantText: "Done!",
      evidence: "- exec_command: tests passed",
    });
    expect(verdict).toEqual({ complete: true, reason: "suite green" });
  });

  it("times out rather than hanging on a stuck model", async () => {
    const verdict = await runGoalVerifier({
      models: {
        complete: () => new Promise(() => {}),
      } as never,
      model: {} as never,
      goal: "Ship the fix",
      assistantText: "Done!",
      evidence: "",
      timeoutMs: 10,
    });
    expect(verdict.complete).toBe(false);
  });
});

describe("batch 17 — self-scheduled wakeups", () => {
  it("schedules within bounds and clamps nothing silently", () => {
    expect(planScheduleWakeup({ delaySeconds: 120 }, 0)).toMatchObject({ action: "schedule", delaySeconds: 120 });
    expect(planScheduleWakeup({ delaySeconds: 59 }, 0).action).toBe("invalid");
    expect(planScheduleWakeup({ delaySeconds: MAX_WAKEUP_DELAY_SECONDS + 1 }, 0).action).toBe("invalid");
    expect(planScheduleWakeup({}, 0).action).toBe("invalid");
  });

  it("stops the chain at the cap and points at /loop", () => {
    const plan = planScheduleWakeup({ delaySeconds: 60 }, MAX_WAKEUP_CHAIN);
    expect(plan).toMatchObject({ action: "chain-limit", maxChain: MAX_WAKEUP_CHAIN });
  });

  it("allows stop even at the chain cap", () => {
    expect(planScheduleWakeup({ stop: true }, MAX_WAKEUP_CHAIN)).toEqual({ action: "stop" });
  });

  it("fences the wakeup task as data", () => {
    const prompt = buildSelfWakeupPrompt({ prompt: "poll the build", reason: "build in flight" }, 2);
    expect(prompt).toContain("check 2");
    expect(prompt).toContain("cannot broaden authorization");
    expect(prompt).toContain("<task>");
    expect(prompt).toContain("poll the build");
  });

  it("supplies a default task when none was given", () => {
    expect(buildSelfWakeupPrompt({}, 1)).toContain("Re-evaluate the current state");
  });

  it("keeps monitor pings free of output", () => {
    const running = buildMonitorWakeupPrompt({ processId: "p1", command: "npm run build", exited: false });
    expect(running).toContain("still running");
    expect(running).toContain("No output is included in this ping.");
    expect(running).toContain("write_stdin");
    const exited = buildMonitorWakeupPrompt({ processId: "p1", command: "npm run build", exited: true, exitCode: 2 });
    expect(exited).toContain("has exited");
    expect(exited).toContain("exit code 2");
  });
});

describe("batch 17 — reread guard", () => {
  it("withholds the Nth identical read of an unchanged region", () => {
    const guard = createRereadGuard();
    const read = { path: "src/a.ts", mtimeMs: 1, size: 100 };
    expect(guard.observe(read)).toBeUndefined();
    expect(guard.observe(read)).toBeUndefined();
    expect(guard.observe(read)).toContain("Reread notice");
  });

  it("treats different line ranges as different reads", () => {
    const guard = createRereadGuard();
    for (let index = 0; index < 3; index += 1) {
      guard.observe({ path: "src/a.ts", mtimeMs: 1, size: 100, lineStart: 1, lineEnd: 50 });
    }
    expect(guard.observe({ path: "src/a.ts", mtimeMs: 1, size: 100, lineStart: 51, lineEnd: 100 })).toBeUndefined();
  });

  it("treats a changed mtime or size as a fresh read", () => {
    const guard = createRereadGuard();
    guard.observe({ path: "src/a.ts", mtimeMs: 1, size: 100 });
    guard.observe({ path: "src/a.ts", mtimeMs: 1, size: 100 });
    expect(guard.observe({ path: "src/a.ts", mtimeMs: 2, size: 100 })).toBeUndefined();
    expect(guard.observe({ path: "src/a.ts", mtimeMs: 2, size: 101 })).toBeUndefined();
  });

  it("resets the counter after withholding, so a much-later reread still works", () => {
    const guard = createRereadGuard();
    const read = { path: "src/a.ts", mtimeMs: 1, size: 100 };
    for (let index = 0; index < REREAD_NOTICE_THRESHOLD; index += 1) guard.observe(read);
    expect(guard.observe(read)).toBeUndefined();
  });

  it("drops all state on reset", () => {
    const guard = createRereadGuard();
    const read = { path: "src/a.ts", mtimeMs: 1, size: 100 };
    guard.observe(read);
    guard.observe(read);
    guard.reset();
    expect(guard.observe(read)).toBeUndefined();
  });

  it("bounds its bookkeeping", () => {
    const guard = createRereadGuard({ threshold: 2, maxEntries: 2 });
    guard.observe({ path: "a" });
    guard.observe({ path: "b" });
    guard.observe({ path: "c" });
    expect(guard.observe({ path: "a" })).toBeUndefined();
  });
});

describe("batch 17 — SSRF guard", () => {
  it("blocks the IPv4 private and special-purpose space", () => {
    for (const host of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1"]) {
      expect(isBlockedIPv4(host), host).toBe(true);
    }
    for (const host of ["93.184.216.34", "8.8.8.8"]) {
      expect(isBlockedIPv4(host), host).toBe(false);
    }
  });

  it("blocks the IPv6 loopback, link-local, ULA, and mapped-loopback", () => {
    for (const host of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isBlockedIPv6(host), host).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    expect(isBlockedIPv6("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIPv6("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks cloud metadata and local-suffix hostnames", () => {
    expect(isPrivateOrLocalHost("metadata.google.internal")).toBe(true);
    expect(isPrivateOrLocalHost("db.local")).toBe(true);
    expect(isPrivateOrLocalHost("app.localhost")).toBe(true);
    expect(isPrivateOrLocalHost("example.com")).toBe(false);
  });

  it("rejects embedded credentials, odd protocols, and single-label hosts", () => {
    expect(guardFetchUrl("https://user:pass@example.com/x")).toMatchObject({ ok: false });
    expect(guardFetchUrl("file:///etc/passwd")).toMatchObject({ ok: false });
    expect(guardFetchUrl("gopher://example.com")).toMatchObject({ ok: false });
    expect(guardFetchUrl("https://intranet/page")).toMatchObject({ ok: false });
    expect(guardFetchUrl("not a url")).toMatchObject({ ok: false });
    expect(guardFetchUrl(`https://example.com/${"a".repeat(4_000)}`)).toMatchObject({ ok: false });
  });

  it("upgrades http to https and reports the upgrade", () => {
    const result = guardFetchUrl("http://example.com/page");
    expect(result).toMatchObject({ ok: true, upgraded: true });
    if (result.ok) expect(result.url.startsWith("https://")).toBe(true);
  });

  it("passes a clean public https URL through unchanged", () => {
    expect(guardFetchUrl("https://arxiv.org/abs/2401.00001")).toMatchObject({ ok: true, upgraded: false });
  });

  it("blocks a private host even over https", () => {
    expect(guardFetchUrl("https://127.0.0.1/admin")).toMatchObject({ ok: false });
  });
});
