import { afterAll, describe, expect, it } from "vitest";
import {
  collectGitignorePatterns,
  parseGitignoreLine,
  rebaseGitignoreRule,
} from "../packages/core/src/gitignore.js";
import {
  formatAnswers,
  validateQuestions,
  type QuestionSpec,
} from "../packages/core/src/question.js";
import { extractModels, formatProbeSummary, probeProviderModels } from "../packages/core/src/models-probe.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b21-"));
  tempDirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content, "utf8");
  }
  return root;
}

describe("batch 21 — gitignore collection", () => {
  it("parses and filters lines", () => {
    expect(parseGitignoreLine("build/")).toBe("build/");
    expect(parseGitignoreLine("  *.log  ")).toBe("*.log");
    expect(parseGitignoreLine("# comment")).toBeUndefined();
    expect(parseGitignoreLine("")).toBeUndefined();
    expect(parseGitignoreLine("!keep/")).toBeUndefined();
    expect(parseGitignoreLine("/")).toBeUndefined();
  });

  it("rebases rules relative to their .gitignore directory", () => {
    expect(rebaseGitignoreRule("build/", "")).toBe("**/build/");
    expect(rebaseGitignoreRule("*.log", "")).toBe("**/*.log");
    expect(rebaseGitignoreRule("/dist", "")).toBe("/dist");
    expect(rebaseGitignoreRule("*.log", "packages/core")).toBe("packages/core/**/*.log");
    expect(rebaseGitignoreRule("/generated", "packages/core")).toBe("packages/core/generated");
    expect(rebaseGitignoreRule("**/snapshots", "packages/core")).toBe("packages/core/**/snapshots");
  });

  it("collects root and nested gitignore rules as workspace globs", async () => {
    const root = await makeWorkspace({
      ".gitignore": "build/\n*.log\n# commented\n",
      "packages/core/.gitignore": "dist/\n/generated\n",
      "packages/core/src/index.ts": "export {};\n",
      "packages/core/dist/out.js": "junk",
    });
    const collection = await collectGitignorePatterns(root);
    expect(collection.truncated).toBe(false);
    expect(collection.patterns).toContain("**/build/");
    expect(collection.patterns).toContain("**/*.log");
    expect(collection.patterns).toContain("packages/core/**/dist/");
    expect(collection.patterns).toContain("packages/core/generated");
    expect(collection.sources).toContain(".gitignore");
    expect(collection.sources).toContain(path.normalize("packages/core/.gitignore").replace(/\\/g, "/"));
  });

  it("stops at the pattern cap and flags truncation", async () => {
    const root = await makeWorkspace({});
    const lines = Array.from({ length: 300 }, (_, index) => `thing-${index}`).join("\n");
    await writeFile(path.join(root, ".gitignore"), lines, "utf8");
    const collection = await collectGitignorePatterns(root);
    expect(collection.patterns.length).toBeLessThanOrEqual(200);
    expect(collection.truncated).toBe(true);
  });

  it("silently skips unreadable gitignore files", async () => {
    const root = await makeWorkspace({});
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", ".gitignore"), "out/\n", "utf8");
    // A directory named .gitignore makes the read fail; collection survives.
    await rm(path.join(root, "sub", ".gitignore"));
    await mkdir(path.join(root, "sub", ".gitignore"));
    const collection = await collectGitignorePatterns(root);
    expect(collection.patterns).toEqual([]);
  });
});

describe("batch 21 — structured questions", () => {
  const valid: QuestionSpec[] = [
    { question: "Which database should this service use?", header: "DB choice", options: ["SQLite (Recommended)", "Postgres"] },
  ];

  it("accepts a well-formed single question", () => {
    expect(validateQuestions(valid)).toBeUndefined();
  });

  it("rejects missing question mark, duplicates, and bad option shapes", () => {
    expect(validateQuestions([{ ...valid[0]!, question: "no question mark" }])).toContain('"?"');
    expect(
      validateQuestions([
        { ...valid[0]! },
        { ...valid[0]! },
      ]),
    ).toContain("duplicates an earlier question");
    expect(validateQuestions([{ ...valid[0]!, options: ["only-one"] }])).toContain("2-4");
    expect(validateQuestions([{ ...valid[0]!, options: ["a", "a"] }])).toContain("duplicate");
    expect(validateQuestions([])).toContain("at least one");
    expect(validateQuestions(Array.from({ length: 5 }, () => ({ ...valid[0]!, question: `Q${Math.random()}?` })))).toContain(
      "at most 4",
    );
  });

  it("formats answers as user decisions and declines as assumptions", () => {
    const answered = formatAnswers(
      [
        { header: "DB choice", question: "Which database?", answer: "SQLite (Recommended)", custom: false },
        { header: "Runner", question: "Which runner?", answer: "bun", custom: true },
      ],
      false,
    );
    expect(answered).toContain("The user answered:");
    expect(answered).toContain("DB choice: SQLite (Recommended)");
    expect(answered).toContain("Runner: bun (typed)");
    expect(answered).toContain("decisions, not suggestions");

    const declined = formatAnswers([], true);
    expect(declined).toContain("declined");
    expect(declined).toContain("best judgment");
    expect(declined).toContain("assumption");
  });
});

describe("batch 21 — provider model probing", () => {
  it("extracts ids from tolerated response shapes", () => {
    expect(extractModels({ data: [{ id: "gpt-x" }, "bare-id"] }).map((model) => model.id)).toEqual(["gpt-x", "bare-id"]);
    expect(extractModels({ models: [{ name: "models/gemini-x", inputTokenLimit: 1_000_000 }] })).toEqual([
      { id: "models/gemini-x", contextWindow: 1_000_000 },
    ]);
    expect(extractModels([{ id: "m1", top_provider: { context_length: 200_000, max_completion_tokens: 8_192 } }])).toEqual([
      { id: "m1", contextWindow: 200_000, maxOutput: 8_192 },
    ]);
    expect(extractModels({ error: "nope" })).toEqual([]);
    expect(extractModels("nope")).toEqual([]);
  });

  it("probes with the family-correct endpoint and reports failures gently", async () => {
    const seen: string[] = [];
    const ok = await probeProviderModels({
      api: "anthropic-messages",
      baseUrl: "https://api.example.test",
      apiKey: "sk-x",
      fetchImpl: (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
        seen.push(String(url));
        expect((init?.headers ?? {})["x-api-key"]).toBe("sk-x");
        return new Response(JSON.stringify({ data: [{ id: "claude-x" }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(seen[0]).toContain("/v1/models");
    expect(ok.ok).toBe(true);
    expect(ok.models.map((model) => model.id)).toEqual(["claude-x"]);

    const google = await probeProviderModels({
      api: "google-generative-ai",
      baseUrl: "https://g.example.test",
      apiKey: "g-key",
      fetchImpl: (async (url: string | URL) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ models: [{ name: "models/gem", outputTokenLimit: 8_192 }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(seen.at(-1)).toContain("/v1beta/models?key=g-key");
    expect(google.models[0]).toMatchObject({ id: "models/gem", maxOutput: 8_192 });

    const failing = await probeProviderModels({
      api: "openai-completions",
      baseUrl: "https://down.example.test/v1",
      fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch,
    });
    expect(failing).toMatchObject({ ok: false });
    expect(failing.detail).toContain("404");

    const unreachable = await probeProviderModels({
      api: "openai-completions",
      baseUrl: "https://unreachable.invalid/v1",
      fetchImpl: (async () => {
        throw new Error("dns fail");
      }) as typeof fetch,
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.detail).toContain("could not reach");
  });

  it("summarizes with context sizes and an overflow suffix", () => {
    const summary = formatProbeSummary(
      [
        { id: "big", contextWindow: 1_000_000 },
        { id: "plain" },
        { id: "third" },
        { id: "fourth" },
      ],
      3,
    );
    expect(summary).toContain("big (context 1000k)");
    expect(summary).toContain("plain");
    expect(summary).toContain("+1 more");
    expect(formatProbeSummary([{ id: "only" }])).toBe("only");
  });
});
