import { describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { applyWorkspacePatch } from "../packages/core/src/patch.js";
import { Workspace } from "../packages/core/src/workspace.js";
import {
  diceSimilarity,
  pairChangedLines,
  renderChangeBlock,
  wordSegments,
} from "../packages/core/src/word-diff.js";
import {
  enforceMcpOutputLimit,
  estimateTextTokens,
  extensionForMimeType,
  formatByteSize,
} from "../packages/core/src/mcp-output.js";

const dirs: string[] = [];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "dscode-b16-"));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

async function patchFile(root: string, patch: string): Promise<string> {
  const workspace = new Workspace(root);
  await workspace.initialize();
  await applyWorkspacePatch(workspace, patch);
  const { readFile } = await import("node:fs/promises");
  const target = /Update File: (.+)$/m.exec(patch)![1]!.trim();
  return readFile(path.join(root, target), "utf8");
}

describe("word-level diff pairing", () => {
  it("scores identical strings 1 and unrelated strings low", () => {
    expect(diceSimilarity("const x = 1;", "const x = 1;")).toBe(1);
    expect(diceSimilarity("const retries = computeBackoff();", "class WebSocketBridge {}")).toBeLessThan(0.3);
  });

  it("pairs similar lines greedily and skips below-threshold pairs", () => {
    const pairs = pairChangedLines(
      ["const timeout = 5000;", "}", "log('retrying');"],
      ["const timeout = 10_000;", "log('retrying now');", "const other = computeBackoff();"],
    );
    expect(pairs).toContainEqual({ removedIndex: 0, addedIndex: 0 });
    expect(pairs).toContainEqual({ removedIndex: 2, addedIndex: 1 });
    // "}" shares too little with any added line to pair.
    expect(pairs.find((pair) => pair.removedIndex === 1)).toBeUndefined();
  });

  it("degrades large blocks to positional pairing", () => {
    const removed = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const added = Array.from({ length: 30 }, (_, i) => `line-${i}-changed`);
    const pairs = pairChangedLines(removed, added);
    expect(pairs).toHaveLength(30);
    expect(pairs[0]).toEqual({ removedIndex: 0, addedIndex: 0 });
  });

  it("marks only changed tokens in a paired line", () => {
    const { old: oldSegments, new: newSegments } = wordSegments(
      "const timeout = 5000;",
      "const timeout = 10_000;",
    );
    const changedOld = oldSegments.filter((segment) => segment.changed).map((segment) => segment.text).join("");
    const changedNew = newSegments.filter((segment) => segment.changed).map((segment) => segment.text).join("");
    expect(changedOld).toContain("5000");
    expect(changedNew).toContain("10_000");
    expect(oldSegments.some((segment) => !segment.changed && segment.text.includes("const"))).toBe(true);
  });

  it("renders paired lines as emphasized and unpaired as whole-line", () => {
    const rendered = renderChangeBlock(
      ["const timeout = 5000;", "totally-different-line"],
      ["const timeout = 10_000;", "another-unrelated"],
    );
    expect(rendered).toHaveLength(4);
    expect(rendered[0]!.emphasized).toBe(true);
    expect(rendered[0]!.segments.some((segment) => segment.changed)).toBe(true);
    expect(rendered[1]!.emphasized).toBe(false);
    expect(rendered[1]!.segments).toEqual([{ text: "totally-different-line", changed: false }]);
  });
});

describe("tolerant patch anchoring", () => {
  it("matches through smart-punctuation differences", async () => {
    const root = await makeWorkspace({
      "code.ts": 'const greeting = "hello"; // the user’s own words\nconst x = 1;\n',
    });
    const result = await patchFile(
      root,
      [
        "*** Begin Patch",
        "*** Update File: code.ts",
        "@@",
        "-const greeting = \"hello\"; // the user’s own words",
        "+const greeting = \"hi\"; // the user’s own words",
        "*** End Patch",
      ].join("\n"),
    );
    expect(result).toContain('const greeting = "hi"');
    expect(result).toContain("const x = 1;");
  });

  it("re-indents the replacement to the file's indentation on indent-insensitive match", async () => {
    const root = await makeWorkspace({ "code.ts": "function run():\n    return start()\n" });
    const result = await patchFile(
      root,
      ["*** Begin Patch", "*** Update File: code.ts", "@@", "-function run():", "-return start()", "+function run():", "+return finish()", "*** End Patch"].join("\n"),
    );
    expect(result).toContain("function run():");
    expect(result).toContain("    return finish()");
    expect(result).not.toContain("return start()");
  });

  it("still prefers exact matching before tolerant modes", async () => {
    const root = await makeWorkspace({ "code.ts": "  indented();\n  plain();\n" });
    const result = await patchFile(
      root,
      ["*** Begin Patch", "*** Update File: code.ts", "@@", "-  plain();", "+  replaced();", "*** End Patch"].join("\n"),
    );
    expect(result).toContain("  indented();");
    expect(result).toContain("  replaced();");
  });

  it("reports a clear error when nothing matches", async () => {
    const root = await makeWorkspace({ "code.ts": "alpha\nbeta\n" });
    const workspace = new Workspace(root);
    await workspace.initialize();
    await expect(
      applyWorkspacePatch(workspace, ["*** Begin Patch", "*** Update File: code.ts", "@@", "-nonexistent", "+x", "*** End Patch"].join("\n")),
    ).rejects.toThrow(/Patch context not found/);
  });
});

describe("mcp output budget", () => {
  it("passes small outputs through untouched", async () => {
    const outcome = await enforceMcpOutputLimit("srv", "small output", 100);
    expect(outcome.spilled).toBe(false);
    expect(outcome.text).toBe("small output");
    expect(estimateTextTokens("x".repeat(400))).toBe(100);
  });

  it("caps oversized output with a spill pointer", async () => {
    const big = "y".repeat(5_000);
    const outcome = await enforceMcpOutputLimit("my-server", big, 100);
    expect(outcome.spilled).toBe(true);
    expect(outcome.text).toContain("[OUTPUT TRUNCATED");
    expect(outcome.text).toContain("mcp-my-server-");
    expect(outcome.text).toContain("read it with read_file");
    expect(outcome.text.length).toBeLessThan(big.length);
  });

  it("maps mime types and formats sizes", () => {
    expect(extensionForMimeType("image/png")).toBe(".png");
    expect(extensionForMimeType("application/pdf")).toBe(".pdf");
    expect(extensionForMimeType("weird/type")).toBe(".bin");
    expect(extensionForMimeType("text/plain; charset=utf-8")).toBe(".txt");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2 KB");
    expect(formatByteSize(3 * 1024 * 1024)).toBe("3 MB");
  });
});
