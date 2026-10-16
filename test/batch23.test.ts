import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultExportFilename,
  fence,
  parseExportTarget,
  renderMessageRows,
  renderSessionHtml,
  renderSessionMarkdown,
} from "../packages/core/src/session-export.js";
import {
  bitmapHasAlpha,
  fitLongerEdge,
  pickOutputFormat,
  shouldCompress,
  compressImageForContext,
  type ImageProcessor,
} from "../packages/core/src/image-compress.js";

describe("batch 23 — export target resolution", () => {
  const base = { cwd: "D:\\repo", sessionId: "abc-123" };

  it("maps bare format keywords to default filenames in cwd", () => {
    for (const format of ["html", "md", "jsonl"] as const) {
      const target = parseExportTarget({ ...base, rawArgs: format });
      expect(target).toMatchObject({ format, path: expect.stringContaining(defaultExportFilename("abc-123", format)) });
    }
  });

  it("defaults to html with no arguments", () => {
    expect(parseExportTarget({ ...base, rawArgs: "" })).toMatchObject({ format: "html" });
  });

  it("uses the extension of a concrete path", () => {
    expect(parseExportTarget({ ...base, rawArgs: "out/session.md" })).toEqual({
      format: "md",
      path: path.resolve("D:\\repo", "out/session.md"),
    });
    expect(parseExportTarget({ ...base, rawArgs: "D:\\tmp\\s.jsonl" })).toEqual({
      format: "jsonl",
      path: "D:\\tmp\\s.jsonl",
    });
  });

  it("rejects paths whose extension carries no format", () => {
    const outcome = parseExportTarget({ ...base, rawArgs: "out/session.txt" });
    expect("error" in outcome && outcome.error).toContain("Cannot infer");
  });
});

describe("batch 23 — session markdown rendering", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Fix the parser." }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Look at parse() first." },
        { type: "text", text: "On it — reading the parser." },
        { type: "toolCall", id: "t1", name: "read_file", arguments: { path: "src/parser.ts" } },
        { type: "toolCall", id: "t2", name: "search_tools", arguments: { query: "x" } },
        { type: "toolCall", id: "t3", name: "exec_command", arguments: { cmd: "pnpm test" } },
      ],
    },
    { role: "toolResult", toolCallId: "t1", toolName: "read_file", content: [{ type: "text", text: "const a = 1;" }] },
    { role: "toolResult", toolCallId: "t3", toolName: "exec_command", content: [{ type: "text", text: "all green" }] },
  ];

  it("folds tool calls into details blocks with their results", () => {
    const markdown = renderSessionMarkdown({
      title: "Fix parser",
      sessionId: "abc",
      exportedAt: "2026-10-16T00:00:00.000Z",
      model: "deepseek/deepseek-chat",
      messages: messages as never,
    });
    expect(markdown).toContain("# Fix parser");
    expect(markdown).toContain("🧑 User");
    expect(markdown).toContain("### 🤖 Assistant");
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("<summary>🔧 read_file {\"path\":\"src/parser.ts\"}</summary>");
    expect(markdown).toContain("const a = 1;");
    expect(markdown).toContain("_Exported from DSCode._");
  });

  it("hides internal plumbing tools and marks missing results", () => {
    const rows = renderMessageRows(messages[1] as never, new Map());
    const joined = rows.join("\n");
    expect(joined).not.toContain("search_tools");
    expect(joined).toContain("_No result captured._");
  });

  it("renders thinking as a collapsed reasoning block", () => {
    const rows = renderMessageRows(messages[1] as never, new Map());
    expect(rows.join("\n")).toContain("<summary>💭 Reasoning</summary>");
  });

  it("extends the fence when content contains triple backticks", () => {
    expect(fence("```\ncode\n```")).toContain("````");
  });

  it("escapes prose in the html export while keeping tool rows live", () => {
    const html = renderSessionHtml({
      title: "Fix <parser>",
      sessionId: "abc",
      exportedAt: "2026-10-16T00:00:00.000Z",
      messages: [
        { role: "user", content: [{ type: "text", text: "Compare <b>bold</b> handling" }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "a.ts" } }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "read_file", content: [{ type: "text", text: "ok" }] },
      ] as never,
    });
    expect(html).toContain("Fix &lt;parser&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("<details>");
  });
});

describe("batch 23 — image compression decisions", () => {
  it("fits the longer edge and preserves aspect", () => {
    expect(fitLongerEdge(4000, 2000)).toEqual({ width: 1200, height: 600 });
    expect(fitLongerEdge(2000, 4000)).toEqual({ width: 600, height: 1200 });
    expect(fitLongerEdge(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("keeps png only for real alpha, otherwise jpeg", () => {
    expect(pickOutputFormat("image/png", true)).toBe("png");
    expect(pickOutputFormat("image/png", false)).toBe("jpeg");
    expect(pickOutputFormat("image/jpeg", false)).toBe("jpeg");
  });

  it("detects alpha in rgba bytes", () => {
    expect(bitmapHasAlpha(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(bitmapHasAlpha(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 128]))).toBe(true);
  });

  it("compresses through an injected processor and reports the ratio", async () => {
    const processor: ImageProcessor = {
      async decode(bytes) {
        const big = bytes[0]! >= 200;
        return big
          ? { width: 2400, height: 1200, rgba: new Uint8Array(2400 * 1200 * 4).fill(255) }
          : { width: 100, height: 50, rgba: new Uint8Array(100 * 50 * 4).fill(255) };
      },
      async resizeEncode(bitmap, options) {
        const bytes = Math.round((bitmap.width * bitmap.height) / 20_000);
        return Buffer.alloc(Math.max(1, bytes));
      },
    };
    const big = await compressImageForContext(
      { base64: Buffer.alloc(5_000, 200).toString("base64"), mediaType: "image/png" },
      processor,
    );
    expect(big).toBeDefined();
    expect(big!.width).toBe(1200);
    expect(big!.height).toBe(600);
    expect(big!.mediaType).toBe("image/jpeg");
    expect(shouldCompress(big!)).toBe(true);
    expect(big!.note).toContain("Image compressed");
    expect(big!.note).toContain("2400x1200 → 1200x600");

    const tiny = await compressImageForContext(
      { base64: Buffer.alloc(5_000, 100).toString("base64"), mediaType: "image/png" },
      processor,
    );
    expect(tiny).toBeDefined();
    expect(tiny!.width).toBe(100);
  });

  it("degrades to undefined without a processor or on failure", async () => {
    expect(await compressImageForContext({ base64: "x", mediaType: "image/png" }, undefined)).toBeUndefined();
    expect(
      await compressImageForContext(
        { base64: "x", mediaType: "image/png" },
        {
          async decode() {
            throw new Error("bad bytes");
          },
          async resizeEncode() {
            throw new Error("unreachable");
          },
        },
      ),
    ).toBeUndefined();
  });

  it("does not flag a pointless compression as worth it", () => {
    expect(
      shouldCompress({
        compressedBase64: "x",
        mediaType: "image/jpeg",
        originalBytes: 1000,
        compressedBytes: 950,
        ratio: 1.05,
        originalWidth: 100,
        originalHeight: 100,
        width: 100,
        height: 100,
      }),
    ).toBe(false);
  });
});
