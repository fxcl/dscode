import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cursorProjectDirNames,
  extractCursorPrompts,
} from "../packages/core/src/competitor-sessions.js";
import {
  IMAGE_TOKEN_ESTIMATE,
  secondaryContextTips,
} from "../packages/core/src/context-prune.js";
import {
  collectCodeSamples,
  codeLearnerSystemPrompt,
  renderCodeSamples,
  runCodebaseTasteLearning,
} from "../packages/core/src/taste.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(prefix = "dscode-batch10-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("codebase taste learning", () => {
  async function seedRepo(): Promise<string> {
    const repo = await tempDir();
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await writeFile(path.join(repo, "src", "index.ts"), "export const main = (): void => {\n  console.log('hi');\n};\n");
    await writeFile(path.join(repo, "src", "util.py"), "def run(x):\n    return x + 1\n");
    await writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await writeFile(path.join(repo, ".git", "config"), "[core]\n");
    await writeFile(path.join(repo, "README.md"), "# docs are not code\n");
    await writeFile(path.join(repo, "logo.png"), "not really a png");
    return repo;
  }

  it("samples only code files, skipping deps/hidden/docs, with stable order", async () => {
    const repo = await seedRepo();
    const samples = await collectCodeSamples(repo);
    const paths = samples.map((sample) => sample.relativePath);
    expect(paths).toEqual(["src/index.ts", "src/util.py"]);
  });

  it("enforces per-file and total character budgets with truncation marks", async () => {
    const repo = await tempDir();
    await writeFile(path.join(repo, "big.ts"), "x".repeat(20_000));
    const samples = await collectCodeSamples(repo);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.truncated).toBe(true);
    expect(samples[0]!.content.length).toBeLessThanOrEqual(8_192);

    const rendered = renderCodeSamples(samples);
    expect(rendered).toContain("### big.ts (truncated)");
  });

  it("returns an empty sample set for a directory without code", async () => {
    const empty = await tempDir();
    await writeFile(path.join(empty, "notes.md"), "text");
    expect(await collectCodeSamples(empty)).toEqual([]);
    const outcome = await runCodebaseTasteLearning({
      models: { complete: async () => { throw new Error("must not be called"); } },
      model: {} as never,
      cwd: empty,
      repoDir: empty,
    });
    expect(outcome.reason).toBe("skipped-empty");
    expect(outcome.samples).toBe(0);
  });

  it("learns through the taste tool loop and commits valid bullets", async () => {
    const repo = await seedRepo();
    const project = await tempDir();
    // One model turn that writes a bullet, then one turn with no tool calls
    // (loop exit).
    let call = 0;
    const models = {
      complete: async () => {
        call += 1;
        if (call === 1) {
          return {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "t1",
                name: "write_taste_file",
                arguments: {
                  path: "taste.md",
                  content: "- TypeScript with explicit return annotations on exports. Confidence: 0.8",
                },
              },
            ],
            timestamp: Date.now(),
          } as never;
        }
        return { role: "assistant", content: [{ type: "text", text: "no changes" }], timestamp: Date.now() } as never;
      },
    };
    const outcome = await runCodebaseTasteLearning({
      models,
      model: {} as never,
      cwd: project,
      repoDir: repo,
    });
    expect(outcome.updated).toBe(true);
    expect(outcome.reason).toBe("learned");
    expect(outcome.entries).toBe(1);
    expect(outcome.samples).toBe(2);
  });

  it("restores the previous taste state when the model writes nothing valid", async () => {
    const repo = await seedRepo();
    const project = await tempDir();
    const tasteDir = path.join(project, ".dscode", "taste");
    await mkdir(tasteDir, { recursive: true });
    await writeFile(
      path.join(tasteDir, "taste.md"),
      "- Keeps bullet lists short. Confidence: 0.7\n",
    );
    let call = 0;
    const models = {
      complete: async () => {
        call += 1;
        if (call === 1) {
          return {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "t1",
                name: "write_taste_file",
                arguments: { path: "taste.md", content: "garbage without confidence lines" },
              },
            ],
            timestamp: Date.now(),
          } as never;
        }
        return { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() } as never;
      },
    };
    const outcome = await runCodebaseTasteLearning({
      models,
      model: {} as never,
      cwd: project,
      repoDir: repo,
    });
    expect(outcome.reason).toBe("rejected");
    const { readFile } = await import("node:fs/promises");
    const restored = await readFile(path.join(tasteDir, "taste.md"), "utf8");
    expect(restored).toContain("Keeps bullet lists short");
    expect(codeLearnerSystemPrompt()).toContain("evidence from the sample code");
  });
});

describe("cursor session import", () => {
  it("generates encoding variants for project paths", () => {
    const names = cursorProjectDirNames("D:\\work\\My Proj");
    expect(names).toContain("D--work-My-Proj");
    expect(names).toContain("d--work-my-proj");
    expect(new Set(names).size).toBe(names.length);
  });

  it("extracts prompts from JSONL transcripts", () => {
    const content = [
      JSON.stringify({ type: "user", message: { role: "user", content: "fix the login bug please" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "on it" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "now add a test" }] } }),
      "not json",
    ].join("\n");
    expect(extractCursorPrompts(content, 10, 600)).toEqual([
      "fix the login bug please",
      "now add a test",
    ]);
  });

  it("extracts prompts from whole-file JSON arrays and message objects", () => {
    const asArray = JSON.stringify([
      { role: "user", content: "refactor the parser module" },
      { role: "assistant", content: "done" },
    ]);
    expect(extractCursorPrompts(asArray, 10, 600)).toEqual(["refactor the parser module"]);

    const asObject = JSON.stringify({
      messages: [
        { role: "user", content: "upgrade the dependencies" },
        { role: "user", content: "<system-injected noise>" },
      ],
    });
    expect(extractCursorPrompts(asObject, 10, 600)).toEqual(["upgrade the dependencies"]);
  });

  it("respects maxPrompts and filters meta noise", () => {
    const content = [
      JSON.stringify({ role: "user", content: "<command-name>/loop</command-name>" }),
      JSON.stringify({ role: "user", content: "first real prompt" }),
      JSON.stringify({ role: "user", content: "second real prompt" }),
    ].join("\n");
    expect(extractCursorPrompts(content, 1, 600)).toEqual(["first real prompt"]);
  });
});

describe("secondary context tips", () => {
  it("stays silent below the light tier", () => {
    expect(secondaryContextTips(0.4, 100, 10)).toEqual([]);
    expect(secondaryContextTips(0.55, 10, 1)).toEqual([]);
  });

  it("fires the session-length and image-weight tips once thresholds pass", () => {
    const tips = secondaryContextTips(0.6, 75, 5);
    expect(tips).toHaveLength(2);
    expect(tips[0]!.key).toBe("secondary-messages");
    expect(tips[0]!.text).toContain("75 messages");
    expect(tips[1]!.key).toBe("secondary-images");
    expect(tips[1]!.text).toContain("5 images");
    expect(IMAGE_TOKEN_ESTIMATE).toBe(1_500);
  });

  it("fires each tip independently", () => {
    expect(secondaryContextTips(0.5, 80, 1).map((tip) => tip.key)).toEqual(["secondary-messages"]);
    expect(secondaryContextTips(0.5, 20, 4).map((tip) => tip.key)).toEqual(["secondary-images"]);
  });
});
