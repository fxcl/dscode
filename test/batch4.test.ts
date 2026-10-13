import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KEEP_RECENT_TOOL_RESULTS,
  pruneOldToolResults,
} from "../packages/core/src/context-prune.js";
import {
  formatKnowledgeListing,
  listKnowledgeFiles,
  pickBestMatch,
  readKnowledgeFile,
} from "../packages/core/src/knowledge.js";
import {
  descriptionCacheKey,
  isValidSynthesis,
  loadDescriptionCache,
  saveDescriptionCache,
  synthesizeToolDescriptions,
} from "../packages/core/src/mcp-describe.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dscode-batch4-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

function toolResult(name: string, text: string): any {
  return {
    role: "toolResult",
    toolCallId: `call-${name}`,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
  };
}

describe("pruneOldToolResults", () => {
  it("keeps the most recent tool results intact and prunes older ones", () => {
    const messages: any[] = [
      { role: "user", content: "start" },
      toolResult("old1", "a".repeat(400)),
      toolResult("old2", "b".repeat(400)),
      { role: "assistant", content: [{ type: "text", text: "working" }] },
      toolResult("recent1", "c".repeat(400)),
      toolResult("recent2", "d".repeat(400)),
    ];
    const pruned = pruneOldToolResults(messages, 2);
    expect(pruned).not.toBe(messages);
    const old1 = pruned[1]!;
    expect(old1.content[0]!.text).toContain("[pruned] old1 output");
    const recent2 = pruned[5]!;
    expect(recent2.content[0]!.text).toBe("d".repeat(400));
    // non-tool-result messages untouched
    expect(pruned[0]).toBe(messages[0]);
    expect(pruned[3]).toBe(messages[3]);
  });

  it("returns the same array when nothing needs pruning", () => {
    const messages: any[] = [toolResult("only", "short"), { role: "user", content: "q" }];
    expect(pruneOldToolResults(messages, KEEP_RECENT_TOOL_RESULTS)).toBe(messages);
  });
});

describe("knowledge files", () => {
  it("lists markdown files recursively with titles", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "skills", "mod-builder"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "mod-builder", "SKILL.md"),
      "# Mod Builder\n\nBuild plugins.",
    );
    await writeFile(path.join(root, "skills", "design.md"), "# Design references");
    const files = await listKnowledgeFiles([root]);
    expect(files).toHaveLength(2);
    const modBuilder = files.find((file) => file.relativePath.includes("mod-builder"));
    expect(modBuilder?.title).toBe("Mod Builder");
  });

  it("matches by basename before path and reads within the root only", async () => {
    const root = await tempDir();
    await mkdir(path.join(root, "a"), { recursive: true });
    await writeFile(path.join(root, "a", "sandbox.md"), "# Sandbox docs");
    await writeFile(path.join(root, "skills-index.md"), "# Skills index");
    const files = await listKnowledgeFiles([root]);
    expect(pickBestMatch(files, "sandbox")?.relativePath).toBe(path.join("a", "sandbox.md").replaceAll("\\", "/"));
    expect(pickBestMatch(files, "missing")).toBeUndefined();
    const content = await readKnowledgeFile(root, path.join("a", "sandbox.md"));
    expect(content).toContain("# Sandbox docs");
    expect(await readKnowledgeFile(root, "..\\outside.md")).toBeUndefined();
  });

  it("formats a listing", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "loop.md"), "# Loop\n\nbody");
    const files = await listKnowledgeFiles([root]);
    expect(formatKnowledgeListing(files)).toContain("loop.md — Loop (1 KB)");
  });
});

describe("mcp description synthesis", () => {
  it("builds stable cache keys per server/tool/description", () => {
    expect(descriptionCacheKey("srv", "tool", "d")).toBe(descriptionCacheKey("srv", "tool", "d"));
    expect(descriptionCacheKey("srv", "tool", "d")).not.toBe(descriptionCacheKey("srv2", "tool", "d"));
  });

  it("validates syntheses: tight, shorter than raw, no assistant chatter", () => {
    const raw = "x".repeat(400);
    expect(isValidSynthesis("Reads a file range and returns its text content.", raw)).toBe(true);
    expect(isValidSynthesis("too short", raw)).toBe(false);
    expect(isValidSynthesis("z".repeat(400), raw)).toBe(false);
    expect(isValidSynthesis("I cannot do that", raw)).toBe(false);
  });

  it("serves from cache, calls the model only for misses, and persists", async () => {
    const cachePath = path.join(await tempDir(), "mcp-descriptions.json");
    const verbose = "Compress me. ".repeat(30);
    let calls = 0;
    const models = {
      complete: async () => {
        calls += 1;
        return {
          role: "assistant",
          content: [{ type: "text", text: "Compresses repeated text blobs into one sentence." }],
          stopReason: "end_turn",
        };
      },
    } as never;
    const tools = [{ name: "compressor", description: verbose }];

    const first = await synthesizeToolDescriptions({
      serverName: "srv",
      tools,
      models,
      model: { id: "lane" } as never,
      cachePath,
    });
    expect(first.get("compressor")).toBeTruthy();
    expect(calls).toBe(1);

    const second = await synthesizeToolDescriptions({
      serverName: "srv",
      tools,
      models,
      model: { id: "lane" } as never,
      cachePath,
    });
    expect(second.get("compressor")).toBeTruthy();
    expect(calls).toBe(1); // cache hit

    const cache = await loadDescriptionCache(cachePath);
    expect(Object.values(cache)[0]).toContain("Compresses");
  });

  it("round-trips the cache file", async () => {
    const cachePath = path.join(await tempDir(), "cache.json");
    await saveDescriptionCache(cachePath, { key1: "value1" });
    expect(await loadDescriptionCache(cachePath)).toEqual({ key1: "value1" });
    expect(await loadDescriptionCache(path.join(cachePath, "missing.json"))).toEqual({});
  });
});
