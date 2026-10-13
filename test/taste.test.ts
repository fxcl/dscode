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

function fakeModels(reply: string) {
  return {
    complete: async () => ({
      role: "assistant",
      content: [{ type: "text", text: reply }],
      stopReason: "end_turn",
    }),
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

describe("taste learning", () => {
  it("writes the updated file and counts entries", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeModels(`${GOOD_TASTE}\n- Uses 2-space indent in YAML. Confidence: 0.7`) as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["Always use tabs, and run pnpm instead of npm."],
    });
    expect(outcome.updated).toBe(true);
    expect(outcome.reason).toBe("learned");
    expect(outcome.entries).toBe(3);
    expect(await readTasteFile(cwd)).toContain("Confidence: 0.9");
  });

  it("treats a no-changes reply as a skip", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeModels("no changes") as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["Fix the bug in main.ts"],
    });
    expect(outcome).toMatchObject({ updated: false, reason: "no-changes" });
    expect(await readTasteFile(cwd)).toBeUndefined();
  });

  it("rejects responses without confidence-scored bullets", async () => {
    const cwd = await tempProject();
    const outcome = await runTasteLearning({
      models: fakeModels("- Likes dark mode") as never,
      model: { id: "deepseek-chat" } as never,
      cwd,
      prompts: ["I like dark mode"],
    });
    expect(outcome).toMatchObject({ updated: false, reason: "rejected" });
  });

  it("dedupes learned prompts through the ledger and honors the toggle", async () => {
    const cwd = await tempProject();
    const models = fakeModels(`${GOOD_TASTE}\n- Commits with conventional prefixes. Confidence: 0.8`) as never;
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

  it("builds a learner system prompt with the confidence contract", () => {
    const prompt = learnerSystemPrompt();
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
      { models: fakeModels(GOOD_TASTE) as never, model: { id: "m" } as never },
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
