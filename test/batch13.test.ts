import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanGeneratedTitle,
  openingExchange,
  titlingSystemPrompt,
  buildTitleMessages,
  TITLE_MAX_WORDS,
} from "../packages/core/src/titling.js";
import {
  formatRepairs,
  repairToolInput,
  TOOL_SCHEMAS,
} from "../packages/core/src/tool-repair.js";
import { contextLeftNote } from "../packages/core/src/status.js";
import { discoverIdeBridge } from "../packages/core/src/ide-bridge.js";
import { packagedDocsRoot } from "../packages/core/src/knowledge.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(prefix = "dscode-b13-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("session auto-titling", () => {
  it("cleans raw model replies into short titles", () => {
    expect(cleanGeneratedTitle('"Fix Parser Bug"')).toBe("Fix Parser Bug");
    expect(cleanGeneratedTitle("Title: Retry Logic")).toBe("Retry Logic");
    expect(cleanGeneratedTitle("add user authentication flow with jwt tokens and tests")).toBe(
      "add user authentication flow",
    );
    expect(cleanGeneratedTitle("...")).toBeUndefined();
    expect(cleanGeneratedTitle("  ")).toBeUndefined();
  });

  it("extracts the opening exchange from session entries", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix the flaky login test" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "on it - checking the retry path" }] } },
      { type: "message", message: { role: "user", content: "later message ignored" } },
    ];
    const exchange = openingExchange(entries);
    expect(exchange?.user).toBe("fix the flaky login test");
    expect(exchange?.assistant).toBe("on it - checking the retry path");
    expect(openingExchange([{ type: "custom", data: {} }])).toBeUndefined();
  });

  it("documents the contract in the prompt and caps title words", () => {
    expect(titlingSystemPrompt()).toContain("one to three words");
    expect(TITLE_MAX_WORDS).toBe(4);
    const messages = buildTitleMessages({ user: "u", assistant: "a" });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });
});

describe("tool input repair", () => {
  it("renames aliased fields to canonical names", () => {
    const input: Record<string, unknown> = { command: "pnpm test", timeout: "5000" };
    const repairs = repairToolInput("exec_command", input);
    expect(input.cmd).toBe("pnpm test");
    expect(input.timeout_ms).toBe(5000);
    expect(input.command).toBeUndefined();
    expect(repairs.some((repair) => repair.rule === "rename" && repair.field === "cmd")).toBe(true);
    expect(repairs.some((repair) => repair.rule === "coerce-number")).toBe(true);
  });

  it("coerces booleans and unwraps markdown links", () => {
    const stdin: Record<string, unknown> = { pid: "p1", terminate: "true", chars: "[src/app.ts](src/app.ts)" };
    const repairs = repairToolInput("write_stdin", stdin);
    expect(stdin.process_id).toBe("p1");
    expect(stdin.terminate).toBe(true);
    expect(stdin.chars).toBe("src/app.ts");
    expect(repairs.filter((repair) => repair.rule === "coerce-boolean")).toHaveLength(1);
  });

  it("drops null values and undeclared fields", () => {
    const input: Record<string, unknown> = { cmd: "ls", extra: "hallucinated", note: null };
    const repairs = repairToolInput("exec_command", input);
    expect(input).toEqual({ cmd: "ls" });
    expect(repairs.filter((repair) => repair.rule === "drop-null")).toHaveLength(2);
  });

  it("leaves inputs alone for unknown tools and clean inputs", () => {
    const unknown: Record<string, unknown> = { anything: 1 };
    expect(repairToolInput("no_such_tool", unknown)).toEqual([]);
    expect(unknown).toEqual({ anything: 1 });
    const clean: Record<string, unknown> = { cmd: "ls -la" };
    expect(repairToolInput("exec_command", clean)).toEqual([]);
    expect(clean).toEqual({ cmd: "ls -la" });
    expect(formatRepairs("exec_command", [])).toBe("");
    expect(formatRepairs("exec_command", [{ rule: "rename", field: "cmd", from: "command" }])).toContain("<- command");
    expect(TOOL_SCHEMAS.length).toBeGreaterThanOrEqual(5);
  });
});

describe("context indicator", () => {
  it("stays hidden while headroom exceeds 20%", () => {
    // 40% used -> 50% left before the 90% ceiling: hidden.
    expect(contextLeftNote({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 })).toBeUndefined();
  });

  it("shows headroom relative to the 90% auto-compact ceiling", () => {
    const note = contextLeftNote({ tokens: 800_000, contextWindow: 1_000_000, percent: 80 });
    expect(note).toContain("~10%");
    expect(note).toContain("/compact");
    // At exactly 90% used, headroom is zero.
    expect(contextLeftNote({ tokens: 900_000, contextWindow: 1_000_000, percent: 90 })).toContain("~0%");
  });

  it("handles missing usage gracefully", () => {
    expect(contextLeftNote(undefined)).toBeUndefined();
    expect(contextLeftNote({ tokens: 0, contextWindow: 1_000_000, percent: null })).toBeUndefined();
  });
});

describe("ide bridge discovery", () => {
  const pipePath = () =>
    process.platform === "win32"
      ? `\\\\.\\pipe\\dscode-vscode-abc12345`
      : path.join(tempDirSync(), ".dscode", "ide", "vscode-abc12345.sock");

  function tempDirSync(): string {
    return fs.mkdtempSync(path.join(tmpdir(), "dscode-ide-"));
  }

  it("finds a live editor discovery file matching the workspace", async () => {
    const home = await tempDir();
    await mkdir(path.join(home, ".dscode", "ide"), { recursive: true });
    const cwd = await tempDir();
    const socketPath = pipePath();
    const discovery = {
      socketPath,
      workspaceFolders: [cwd],
      pid: process.pid,
      ideName: "vscode",
    };
    await writeFile(path.join(home, ".dscode", "ide", `vscode-abc12345.json`), JSON.stringify(discovery));
    const found = await discoverIdeBridge(cwd, home);
    expect(found?.socketPath).toBe(discovery.socketPath);
    expect(found?.ideName).toBe("vscode");
  });

  it("removes stale entries (dead pid) and ignores foreign workspaces", async () => {
    const home = await tempDir();
    const ideDir = path.join(home, ".dscode", "ide");
    await mkdir(ideDir, { recursive: true });
    const socketPath = pipePath();
    const stale = path.join(ideDir, "vscode-dead0001.json");
    await writeFile(
      stale,
      JSON.stringify({ socketPath, workspaceFolders: [home], pid: 999_999_999, ideName: "vscode" }),
    );
    const foreign = path.join(ideDir, "vscode-beef0002.json");
    await writeFile(
      foreign,
      JSON.stringify({
        socketPath,
        workspaceFolders: ["D:/somewhere-else"],
        pid: process.pid,
        ideName: "vscode",
      }),
    );
    const other = await tempDir();
    expect(await discoverIdeBridge(other, home)).toBeUndefined();
    const dirAfter = await import("node:fs/promises").then((fs) => fs.readdir(ideDir));
    expect(dirAfter).not.toContain("vscode-dead0001.json");
  });

  it("ships packaged knowledge docs", async () => {
    const { readFile: read } = await import("node:fs/promises");
    const root = packagedDocsRoot();
    const index = await read(path.join(root, "index.md"), "utf8");
    expect(index).toContain("DSCode reference index");
    for (const name of ["permissions.md", "providers.md", "headless.md", "mcp.md", "memory.md", "tools.md"]) {
      await expect(read(path.join(root, name), "utf8")).resolves.toContain("# ");
    }
  });
});
