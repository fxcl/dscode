import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  expandMemoryImports,
  extractMentionedPaths,
  loadMemoryContext,
  MEMORY_IMPORT_MAX_DEPTH,
} from "../packages/core/src/memory.js";
import {
  ORPHAN_TOOL_RESULT_TEXT,
  repairOrphanToolResults,
} from "../packages/core/src/context-prune.js";
import {
  abandonedMessageCount,
  collectRewindPoints,
  REWIND_ENTRY,
  selectorWindow,
} from "../packages/core/src/rewind.js";
import { CHECKPOINT_ENTRY } from "../packages/core/src/checkpoint.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(prefix = "dscode-batch11-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("memory @imports", () => {
  it("extracts quoted and bare @mentions", () => {
    expect(extractMentionedPaths(["look at @src/index.ts please", 'also @"path with spaces/x.txt"'])).toEqual([
      "src/index.ts",
      "path with spaces/x.txt",
    ]);
    // The mention regex is intentionally broad (email-like tokens included);
    // only mentions that resolve to real files ever load content.
    expect(extractMentionedPaths(["email@example.com stays"])).toEqual(["example.com"]);
  });

  it("expands @imports relative to the memory file, resolving ~/", async () => {
    const home = await tempDir();
    const base = await tempDir();
    await writeFile(path.join(base, "detail.md"), "- detail bullet from detail.md");
    await writeFile(path.join(home, "global.md"), "- global bullet");
    const content = [
      "# Main",
      "Import inline: @detail.md",
      "Home import: @~/global.md",
      "Missing stays: @does-not-exist.md",
      "Inline code is exempt: `@detail.md`",
      "Fenced code is exempt:",
      "```",
      "@detail.md",
      "```",
    ].join("\n");
    const expanded = await expandMemoryImports(content, base, home);
    expect(expanded).toContain("# Imported from detail.md");
    expect(expanded).toContain("- detail bullet from detail.md");
    expect(expanded).toContain("- global bullet");
    expect(expanded).toContain("Missing stays: @does-not-exist.md");
    expect(expanded).toContain("`@detail.md`");
    expect(expanded).toContain("@detail.md\n```");
  });

  it("caps import nesting depth", async () => {
    const base = await tempDir();
    // a -> b -> c -> ... beyond the cap: the deepest level stays unexpanded.
    const chainDepth = MEMORY_IMPORT_MAX_DEPTH + 3;
    for (let i = 0; i < chainDepth; i += 1) {
      await writeFile(path.join(base, `level${i}.md`), `level ${i}\n@level${i + 1}.md`);
    }
    await writeFile(path.join(base, `level${chainDepth}.md`), `level ${chainDepth} (deepest)`);
    const expanded = await expandMemoryImports(await readFile(path.join(base, "level0.md"), "utf8"), base);
    const loadedLevels = expanded.match(/# Imported from level\d+\.md/g)?.length ?? 0;
    expect(loadedLevels).toBe(MEMORY_IMPORT_MAX_DEPTH);
    // The deepest level is read but never expanded further.
    expect(expanded).toContain("level 5");
    expect(expanded).not.toContain("level 8 (deepest)");
  });

  it("loads user layer, project layer, and mention-activated nested layers", async () => {
    const home = await tempDir();
    const project = await tempDir();
    await mkdir(path.join(home, ".dscode"), { recursive: true });
    await mkdir(path.join(project, "packages", "app"), { recursive: true });
    await mkdir(path.join(project, "docs"), { recursive: true });
    await writeFile(path.join(home, ".dscode", "AGENTS.md"), "- user layer bullet");
    await writeFile(path.join(project, "AGENTS.md"), "- project layer bullet\nImport: @docs/extra.md");
    await writeFile(path.join(project, "docs", "extra.md"), "- imported docs bullet");
    await writeFile(path.join(project, "packages", "AGENTS.md"), "- nested packages bullet");
    // The mentioned file must exist for the nested layer to activate.
    await writeFile(path.join(project, "packages", "app", "main.ts"), "export {};\n");

    // No mentions: user + project only, project @import expanded.
    const base = await loadMemoryContext({ cwd: project, home });
    expect(base).toContain("# Memory from:");
    expect(base).toContain("- user layer bullet");
    expect(base).toContain("- project layer bullet");
    expect(base).toContain("- imported docs bullet");
    expect(base).toContain("---");
    expect(base).not.toContain("- nested packages bullet");

    // Mentioning a file under packages/app activates the nested layer.
    const withMention = await loadMemoryContext({
      cwd: project,
      home,
      mentionedPaths: [path.join(project, "packages", "app", "main.ts")],
    });
    expect(withMention).toContain("- nested packages bullet");
  });
});

describe("orphaned tool-call repair", () => {
  const assistant = (toolId: string, name = "exec_command"): AgentMessage =>
    ({ role: "assistant", content: [{ type: "toolCall", id: toolId, name, arguments: {} }] }) as AgentMessage;
  const result = (toolId: string): AgentMessage =>
    ({ role: "toolResult", toolCallId: toolId, toolName: "exec_command", content: [{ type: "text", text: "done" }] }) as AgentMessage;

  it("appends a synthetic result after each orphaned tool call", () => {
    const messages = [assistant("call-1"), assistant("call-2"), result("call-2")];
    const repaired = repairOrphanToolResults(messages);
    expect(repaired).not.toBe(messages);
    expect(repaired).toHaveLength(4);
    const synthetic = repaired[1] as { role: string; toolCallId: string; content: Array<{ text: string }> };
    expect(synthetic.role).toBe("toolResult");
    expect(synthetic.toolCallId).toBe("call-1");
    expect(synthetic.content[0]!.text).toBe(ORPHAN_TOOL_RESULT_TEXT);
  });

  it("returns the input untouched when every call has a result", () => {
    const messages = [assistant("call-1"), result("call-1"), assistant("call-2"), result("call-2")];
    expect(repairOrphanToolResults(messages)).toBe(messages);
    const empty: AgentMessage[] = [];
    expect(repairOrphanToolResults(empty)).toBe(empty);
  });

  it("repairs several orphans in one assistant message in order", () => {
    const multi = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "a", name: "exec_command", arguments: {} },
        { type: "toolCall", id: "b", name: "apply_patch", arguments: {} },
      ],
    } as AgentMessage;
    const repaired = repairOrphanToolResults([multi]);
    expect(repaired).toHaveLength(3);
    expect((repaired[1] as { toolCallId: string }).toolCallId).toBe("a");
    expect((repaired[2] as { toolCallId: string }).toolCallId).toBe("b");
  });
});

describe("rewind points", () => {
  const entry = (id: string, type: SessionEntry["type"], data?: unknown, customType?: string): SessionEntry =>
    ({ id, type, ...(type === "custom" ? { customType: customType ?? (type === "custom" ? REWIND_ENTRY : ""), data } : {}) }) as SessionEntry;

  it("collects points and attaches later checkpoints to their owning point", () => {
    const entries = [
      entry("m1", "message"),
      entry("r1", "custom", { entryId: "m1", prompt: "first task", createdAt: 1 }, REWIND_ENTRY),
      entry("cp1", "custom", { id: "cp1", createdAt: "", patch: "", before: [], after: [] }, CHECKPOINT_ENTRY),
      entry("m2", "message"),
      entry("r2", "custom", { entryId: "m2", prompt: "second task", createdAt: 2 }, REWIND_ENTRY),
      entry("cp2", "custom", { id: "cp2", createdAt: "", patch: "", before: [], after: [] }, CHECKPOINT_ENTRY),
    ];
    const points = collectRewindPoints(entries);
    expect(points).toHaveLength(2);
    expect(points[0]!.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(["cp1", "cp2"]);
    expect(points[1]!.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(["cp2"]);
  });

  it("skips undone checkpoints and drops invalid point data", () => {
    const entries = [
      entry("r1", "custom", { entryId: null, prompt: "start", createdAt: 1 }, REWIND_ENTRY),
      entry("cp1", "custom", { id: "cp1", createdAt: "", patch: "", before: [], after: [] }, CHECKPOINT_ENTRY),
      entry("cp2", "custom", { id: "cp2", createdAt: "", patch: "", before: [], after: [] }, CHECKPOINT_ENTRY),
      entry("bad", "custom", { nope: true }, "dscode-unknown"),
    ];
    const points = collectRewindPoints(entries, (id) => id === "cp1");
    expect(points).toHaveLength(1);
    expect(points[0]!.entryId).toBeNull();
    expect(points[0]!.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(["cp2"]);
  });

  it("windows the selector to the most recent points", () => {
    const points = Array.from({ length: 12 }, (_, index) => ({
      entryId: `e${index}`,
      prompt: `task ${index}`,
      createdAt: index,
      index,
      checkpoints: [],
    }));
    const visible = selectorWindow(points);
    expect(visible).toHaveLength(8);
    expect(visible[0]!.prompt).toBe("task 4");
  });

  it("counts abandoned conversation messages after the target", () => {
    const entries = [
      entry("m1", "message"),
      entry("r1", "custom", { entryId: "m1", prompt: "p", createdAt: 1 }),
      entry("m2", "message"),
      entry("m3", "message"),
      entry("custom-other", "custom", {}),
    ];
    expect(abandonedMessageCount(entries, 1)).toBe(2);
    expect(abandonedMessageCount(entries, 4)).toBe(0);
  });
});
