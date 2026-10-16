import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import fg from "fast-glob";
import type { HarnessMode } from "./config.js";
import { collectGitignorePatterns } from "./gitignore.js";
import { applyWorkspacePatch } from "./patch.js";
import { runProcess } from "./process.js";
import { Workspace } from "./workspace.js";

const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.dscode/**",
];

export function createCodingTools(workspace: Workspace, harness: HarnessMode = "safe"): AgentTool[] {
  // User-declared .gitignore rules, collected once per factory (session)
  // and merged into every listing and search below.
  const gitignore = collectGitignorePatterns(workspace.root).catch(() => undefined);
  const gitignorePatterns = async (): Promise<string[]> => (await gitignore)?.patterns ?? [];
  const readFileParameters = Type.Object({
    path: Type.String({ description: "Workspace-relative file path" }),
    line_start: Type.Optional(Type.Integer({ minimum: 1, description: "First line, inclusive" })),
    line_end: Type.Optional(Type.Integer({ minimum: 1, description: "Last line, inclusive" })),
  });
  const readFile: AgentTool<typeof readFileParameters> = {
    name: "read_file",
    label: "Read file",
    description:
      "Read a UTF-8 text file inside the workspace. Returns numbered lines. Use line_start and line_end for large files.",
    parameters: readFileParameters,
    execute: async (_id, params) => {
      const absolute = await workspace.resolve(params.path);
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${params.path}`);
      }
      if (stat.size > 5_000_000) {
        throw new Error(`File is too large to read (${stat.size} bytes): ${params.path}`);
      }

      const content = await fs.readFile(absolute, "utf8");
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, params.line_start ?? 1);
      const end = Math.min(lines.length, params.line_end ?? Math.min(lines.length, start + 499));
      if (end < start) {
        throw new Error(`Invalid line range: ${start}-${end}`);
      }

      const selected = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(6)}\t${line}`)
        .join("\n");
      const suffix = end < lines.length ? `\n\n[${lines.length - end} more lines; continue from line ${end + 1}]` : "";

      return {
        content: [{ type: "text", text: selected + suffix }],
        details: { path: workspace.relative(absolute), start, end, totalLines: lines.length },
      };
    },
  };

  const listFilesParameters = Type.Object({
    pattern: Type.Optional(
      Type.String({ description: "Glob pattern relative to workspace, default **/*" }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  });
  const listFiles: AgentTool<typeof listFilesParameters> = {
    name: "list_files",
    label: "List files",
    description:
      "List files inside the workspace using a glob. Hidden files are included; common generated directories are excluded.",
    parameters: listFilesParameters,
    execute: async (_id, params) => {
      const limit = params.limit ?? 500;
      const pattern = params.pattern ?? "**/*";
      assertSafeGlob(pattern);
      const matches = await fg(pattern, {
        cwd: workspace.root,
        onlyFiles: true,
        dot: true,
        followSymbolicLinks: false,
        ignore: [...DEFAULT_IGNORES, ...(await gitignorePatterns())],
        unique: true,
      });
      matches.sort();
      const selected = matches.slice(0, limit);
      const suffix = matches.length > limit ? `\n[${matches.length - limit} more files omitted]` : "";
      return {
        content: [{ type: "text", text: selected.join("\n") + suffix || "(no files)" }],
        details: { count: selected.length, total: matches.length },
      };
    },
  };

  const searchFilesParameters = Type.Object({
    query: Type.String({ minLength: 1, description: "Literal text or regular expression" }),
    path: Type.Optional(Type.String({ description: "File or directory to search, default ." })),
    glob: Type.Optional(Type.String({ description: "Optional file glob, e.g. *.ts" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat query as literal text" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  });
  const searchFiles: AgentTool<typeof searchFilesParameters> = {
    name: "search_files",
    label: "Search files",
    description:
      "Search text in workspace files with ripgrep. Returns file paths, line numbers, and matching lines.",
    parameters: searchFilesParameters,
    execute: async (_id, params, signal) => {
      const searchPath = await workspace.resolve(params.path ?? ".");
      const limit = params.limit ?? 200;
      const args = [
        "--line-number",
        "--column",
        "--color=never",
        "--hidden",
        "--max-count",
        String(limit),
        ...DEFAULT_IGNORES.flatMap((item) => ["--glob", `!${item}`]),
        ...(await gitignorePatterns()).flatMap((item) => ["--glob", `!${item}`]),
      ];
      if (params.literal ?? false) args.push("--fixed-strings");
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", params.query, searchPath);

      const result = await runProcess("rg", args, {
        cwd: workspace.root,
        signal,
        timeoutMs: 30_000,
        maxOutputBytes: 150_000,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(result.stderr || `ripgrep exited with code ${result.exitCode}`);
      }
      const output = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => line.replaceAll(`${workspace.root}${path.sep}`, ""))
        .join("\n");
      return {
        content: [{ type: "text", text: output || "(no matches)" }],
        details: { truncated: result.truncated || output.split("\n").length >= limit },
      };
    },
  };

  const writeFileParameters = Type.Object({
    path: Type.String({ description: "Workspace-relative file path" }),
    content: Type.String({ description: "Complete new file content" }),
  });
  const writeFile: AgentTool<typeof writeFileParameters> = {
    name: "write_file",
    label: "Write file",
    description:
      "Create or completely overwrite a UTF-8 text file inside the workspace. Prefer edit_file for focused changes.",
    parameters: writeFileParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const absolute = await workspace.resolve(params.path, true);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await writeFileAtomic(absolute, params.content);
      return {
        content: [{ type: "text", text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}` }],
        details: { path: workspace.relative(absolute), bytes: Buffer.byteLength(params.content) },
      };
    },
  };

  const editFileParameters = Type.Object({
    path: Type.String({ description: "Workspace-relative file path" }),
    old_text: Type.String({ minLength: 1, description: "Exact text to replace" }),
    new_text: Type.String({ description: "Replacement text" }),
    replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence" })),
  });
  const editFile: AgentTool<typeof editFileParameters> = {
    name: "edit_file",
    label: "Edit file",
    description:
      "Replace an exact text block in a workspace file. By default old_text must occur exactly once.",
    parameters: editFileParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const absolute = await workspace.resolve(params.path);
      const content = await fs.readFile(absolute, "utf8");
      const occurrences = countOccurrences(content, params.old_text);
      if (occurrences === 0) {
        throw new Error(`old_text was not found in ${params.path}`);
      }
      if (occurrences > 1 && !(params.replace_all ?? false)) {
        throw new Error(
          `old_text occurs ${occurrences} times in ${params.path}; provide more context or set replace_all`,
        );
      }
      const updated = params.replace_all
        ? content.split(params.old_text).join(params.new_text)
        : content.replace(params.old_text, params.new_text);
      await writeFileAtomic(absolute, updated);
      return {
        content: [{ type: "text", text: `Updated ${params.path} (${params.replace_all ? occurrences : 1} replacement)` }],
        details: {
          path: workspace.relative(absolute),
          replacements: params.replace_all ? occurrences : 1,
        },
      };
    },
  };

  const runCommandParameters = Type.Object({
    command: Type.String({ minLength: 1, description: "Shell command to execute" }),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
  });
  const runCommand: AgentTool<typeof runCommandParameters> = {
    name: "run_command",
    label: "Run command",
    description:
      "Run a shell command from the workspace root. Use for tests, builds, git inspection, and tasks not covered by other tools.",
    parameters: runCommandParameters,
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const result = await runProcess(params.command, [], {
        cwd: workspace.root,
        signal,
        timeoutMs: (params.timeout_seconds ?? 120) * 1_000,
        maxOutputBytes: 40_000,
        shell: process.env.SHELL ?? "/bin/sh",
      });
      const sections = [
        result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : "",
        result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : "",
        `exit_code: ${result.exitCode}`,
        result.timedOut ? "timed_out: true" : "",
        result.truncated ? "output_truncated: true" : "",
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: {
          command: params.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      };
    },
  };

  const execCommandParameters = Type.Object({
    cmd: Type.String({ minLength: 1, description: "Shell command to execute" }),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 600_000 })),
  });
  const execCommand: AgentTool<typeof execCommandParameters> = {
    name: "exec_command",
    label: "Execute command",
    description:
      "Execute a shell command from the workspace root. Prefer rg and rg --files for search; run focused checks before broad test suites.",
    parameters: execCommandParameters,
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const result = await runProcess(params.cmd, [], {
        cwd: workspace.root,
        signal,
        timeoutMs: params.timeout_ms ?? 120_000,
        maxOutputBytes: 40_000,
        shell: process.env.SHELL ?? "/bin/sh",
      });
      const sections = [
        result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : "",
        result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : "",
        `exit_code: ${result.exitCode}`,
        result.timedOut ? "timed_out: true" : "",
        result.truncated ? "output_truncated: true (showing a bounded excerpt)" : "",
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: {
          command: params.cmd,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      };
    },
  };

  const applyPatchParameters = Type.Object({
    input: Type.String({
      minLength: 1,
      description: "A complete *** Begin Patch / *** End Patch patch",
    }),
  });
  const applyPatch: AgentTool<typeof applyPatchParameters> = {
    name: "apply_patch",
    label: "Apply patch",
    description:
      "Apply an atomic-style patch inside the workspace. Supports Add File, Update File, Delete File, and Move to directives.",
    parameters: applyPatchParameters,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_regex: "[\\s\\S]*" },
    },
    executionMode: "sequential",
    execute: async (_id, params) => {
      const result = await applyWorkspacePatch(workspace, params.input);
      return {
        content: [
          {
            type: "text",
            text: `Applied patch to ${result.files.length} file(s): +${result.additions} -${result.deletions}\n${result.files.join("\n")}`,
          },
        ],
        details: result,
      };
    },
  };

  if (harness === "minimal") {
    return [execCommand, applyPatch];
  }
  return [readFile, listFiles, searchFiles, writeFile, editFile, runCommand];
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function assertSafeGlob(pattern: string): void {
  const normalized = pattern.replaceAll("\\", "/");
  if (
    path.isAbsolute(pattern) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Glob escapes workspace: ${pattern}`);
  }
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.dscode-${process.pid}-${Date.now()}.tmp`,
  );
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
