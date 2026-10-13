import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTaste,
  countLearnings,
  extractUserTexts,
  isTasteEnabled,
  learnFromNewMessages,
  learnerSystemPrompt,
  readTasteFile,
  runTasteLearning,
  setTasteEnabled,
  validateTasteRelativePath,
} from "../packages/core/src/taste.js";
import {
  claudeCodeProjectDirName,
  extractClaudeCodePrompts,
  extractCodexPrompts,
} from "../packages/core/src/competitor-sessions.js";

const dirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dscode-taste-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

const GOOD_TASTE = [
  "# Taste",
  "",
  "- Prefers tabs over spaces. Confidence: 0.9",
  "- Runs pnpm, never npm. Confidence: 0.8",
].join("\n");

const textMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});

const toolCallMessage = (id: string, name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
  stopReason: "toolUse",
});

/** Scripted learning model: one step per turn; the last step repeats. */
function fakeLoopModel(steps: Array<Record<string, unknown>>) {
  let turn = 0;
  return {
    complete: async () => {
      const step = steps[Math.min(turn, steps.length - 1)]!;
      turn += 1;
      return step;
    },
  };
}

describe("taste paths", () => {
  it("accepts only taste.md or one-level category files", () => {
    expect(validateTasteRelativePath("taste.md")).toBe("taste.md");
    expect(validateTasteRelativePath("style/taste.md")).toBe("style/taste.md");
    expect(validateTasteRelativePath("a/b/taste.md")).toBeUndefined();
    expect(validateTasteRelativePath("notes.md")).toBeUndefined();
    expect(validateTasteRelativePath("../escape/taste.md")).toBeUndefined();
    expect(validateTasteRelativePath(".hidden/taste.md")).toBeUndefined();
  });
});

describe("taste learning tool loop", () => {
  it("writes via write_taste_file and counts entries", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeLoopModel([
        toolCallMessage("t1", "write_taste_file", {
          path: "taste.md",
          content: `${GOOD_TASTE}\n- Uses 2-space YAML indent. Confidence: 0.7`,
        }),
        textMessage("done"),
      ]) as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["Always use tabs, and run pnpm instead of npm."],
    });
    expect(outcome.updated).toBe(true);
    expect(outcome.reason).toBe("learned");
    expect(outcome.entries).toBe(3);
    expect(outcome.turns).toBe(2);
    expect(await readTasteFile(cwd)).toContain("Confidence: 0.9");
  });

  it("supports multi-turn read/write/edit iteration across category files", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeLoopModel([
        toolCallMessage("t1", "write_taste_file", { path: "taste.md", content: GOOD_TASTE }),
        toolCallMessage("t2", "write_taste_file", {
          path: "testing/taste.md",
          content: "- Always writes table-driven tests. Confidence: 0.8",
        }),
        toolCallMessage("t3", "edit_taste_file", {
          path: "taste.md",
          old_text: "Confidence: 0.8",
          new_text: "Confidence: 0.85",
        }),
        textMessage("done"),
      ]) as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["Use table-driven tests for everything."],
    });
    expect(outcome.reason).toBe("learned");
    expect(outcome.entries).toBe(3);
    const root = await readTasteFile(cwd);
    expect(root).toContain("Confidence: 0.85");
    const testing = await readFile(path.join(cwd, ".dscode", "taste", "testing", "taste.md"), "utf8");
    expect(testing).toContain("table-driven");
  });

  it("returns errors to the model when a path escapes the taste directory", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeLoopModel([
        toolCallMessage("t1", "write_taste_file", { path: "../evil.md", content: "evil" }),
        toolCallMessage("t2", "write_taste_file", { path: "taste.md", content: GOOD_TASTE }),
        textMessage("done"),
      ]) as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["Use tabs."],
    });
    // The escaped write failed (nothing outside .dscode/taste), the retried
    // root write landed.
    expect(outcome.reason).toBe("learned");
    expect(outcome.entries).toBe(2);
    expect(await readFile(path.join(cwd, "evil.md"), "utf8").then(() => "exists").catch(() => "absent")).toBe("absent");
  });

  it("treats a no-tool-call reply as no changes", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeLoopModel([textMessage("no changes")]) as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["Fix the bug in main.ts"],
    });
    expect(outcome).toMatchObject({ updated: false, reason: "no-changes" });
    expect(await readTasteFile(cwd)).toBeUndefined();
  });

  it("reverts a session that ends without valid confidence bullets", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeLoopModel([
        toolCallMessage("t1", "write_taste_file", { path: "taste.md", content: "- Likes dark mode" }),
        textMessage("done"),
      ]) as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["I like dark mode"],
    });
    expect(outcome).toMatchObject({ updated: false, reason: "rejected" });
    expect(await readTasteFile(cwd)).toBeUndefined();
  });

  it("dedupes learned prompts through the ledger and honors the toggle", async () => {
    const cwd = await tempProject();
    const steps = [
      toolCallMessage("t1", "write_taste_file", {
        path: "taste.md",
        content: `${GOOD_TASTE}\n- Commits with conventional prefixes. Confidence: 0.8`,
      }),
      textMessage("done"),
    ];
    const models = fakeLoopModel(steps) as never;
    const model = { id: "deepseek-chat" } as never;
    const messages = [
      { role: "user", content: "Please use conventional commit prefixes for all commits." },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];
    const first = await learnFromNewMessages({ models, model }, cwd, messages);
    expect(first.updated).toBe(true);

    // Same prompt again: already in the ledger, nothing considered.
    const second = await learnFromNewMessages({ models, model }, cwd, messages);
    expect(second).toMatchObject({ updated: false, reason: "skipped-empty", considered: 0 });

    await setTasteEnabled(cwd, false);
    expect(await isTasteEnabled(cwd)).toBe(false);
    const third = await learnFromNewMessages({ models, model }, cwd, [
      { role: "user", content: "Brand new prompt that has never been seen before." },
    ]);
    expect(third).toMatchObject({ reason: "disabled" });

    await clearTaste(cwd);
    expect(await readTasteFile(cwd)).toBeUndefined();
  });

  it("extracts genuine user texts and skips framework injections", () => {
    const texts = extractUserTexts([
      { role: "user", content: "<compacted_session_history>old</compacted_session_history>" },
      { role: "user", content: "Real question about the build" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: [{ type: "text", text: "Second real prompt" }] },
      { role: "user", content: [] },
    ]);
    expect(texts).toEqual(["Real question about the build", "Second real prompt"]);
  });

  it("builds a learner system prompt with the tool-loop contract", () => {
    const prompt = learnerSystemPrompt();
    expect(prompt).toContain("read_taste_file");
    expect(prompt).toContain("Confidence:");
    expect(prompt).toContain("no changes");
    expect(prompt).toContain("NEW user prompts");
  });
});

describe("competitor session extraction", () => {
  it("extracts user prompts from Claude Code JSONL and drops meta noise", () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Refactor the parser module" },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ tool_result: "x", type: "tool_result" }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "<system-reminder>noise</system-reminder>" },
      }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } }),
      "not json",
    ].join("\n");
    expect(extractClaudeCodePrompts(jsonl, 10, 600)).toEqual(["Refactor the parser module"]);
  });

  it("finds user messages in Codex rollouts regardless of envelope shape", () => {
    const jsonl = [
      JSON.stringify({
        timestamp: "1",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Run the tests every time" }] },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
    ].join("\n");
    expect(extractCodexPrompts(jsonl, 10, 600)).toEqual(["Run the tests every time"]);
  });

  it("encodes project paths the way Claude Code names its directories", () => {
    expect(claudeCodeProjectDirName("/Users/alice/dev/my app")).toBe("-Users-alice-dev-my-app");
    expect(claudeCodeProjectDirName("C:\\Users\\alice\\proj")).toBe("C--Users-alice-proj");
  });
});

describe("taste file persistence", () => {
  it("persists the ledger next to the taste file", async () => {
    const cwd = await tempProject();
    await learnFromNewMessages(
      {
        models: fakeLoopModel([
          toolCallMessage("t1", "write_taste_file", { path: "taste.md", content: GOOD_TASTE }),
          textMessage("done"),
        ]) as never,
        model: { id: "m" } as never,
      },
      cwd,
      [{ role: "user", content: "x".repeat(50) }],
    );
    const raw = await readFile(path.join(cwd, ".dscode", "taste", ".learned.json"), "utf8");
    expect(JSON.parse(raw).version).toBe(1);
    expect(countLearnings(GOOD_TASTE)).toBe(2);
    await writeFile(path.join(cwd, ".dscode", "taste", "taste.md"), GOOD_TASTE, "utf8");
    expect((await readTasteFile(cwd))?.includes("tabs")).toBe(true);
  });
});
