import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addTrustedHook,
  appendHookAudit,
  filterTrustedHooks,
  hookAuditPath,
  hookCommandHash,
  loadTrustedHookHashes,
  trustedHooksPath,
} from "../packages/core/src/hook-trust.js";

const dirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dscode-hooktrust-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

interface HookLike {
  command: string;
  args: readonly string[];
}

describe("hook trust", () => {
  it("hashes command+args stably and distinguishes args", () => {
    expect(hookCommandHash("rg", ["-n", "x"])).toBe(hookCommandHash("rg", ["-n", "x"]));
    expect(hookCommandHash("rg", ["-n", "x"])).not.toBe(hookCommandHash("rg", ["-n", "y"]));
    expect(hookCommandHash("rg", [])).not.toBe(hookCommandHash("rg.exe", []));
  });

  it(
    "round-trips the trust file and caps entries",
    async () => {
      const home = await tempHome();
      await addTrustedHook(trustedHooksPath(home), "h1", "cmd1");
      await addTrustedHook(trustedHooksPath(home), "h2", "cmd2");
      const hashes = await loadTrustedHookHashes(trustedHooksPath(home));
      expect(hashes.has("h1") && hashes.has("h2")).toBe(true);
      const raw = JSON.parse(await readFile(trustedHooksPath(home), "utf8"));
      expect(raw.version).toBe(1);
      expect(raw.hashes[0].command).toBe("cmd1");

      // Cap: flood and confirm the file keeps the most recent MAX entries.
      for (let index = 0; index < 510; index += 1) {
        await addTrustedHook(trustedHooksPath(home), `h${index}`, "cmd");
      }
      const flooded = await loadTrustedHookHashes(trustedHooksPath(home));
      expect(flooded.size).toBeLessThanOrEqual(500);
      expect(flooded.has("h509")).toBe(true);
      expect(flooded.has("h1")).toBe(false);
    },
    30_000,
  );

  it("partitions hooks into allowed and untrusted", () => {
    const trusted = new Set([hookCommandHash("rg", ["-n", "q"])]);
    const hooks: HookLike[] = [
      { command: "rg", args: ["-n", "q"] },
      { command: "rm", args: ["-rf", "/"] },
    ];
    const { allowed, untrusted } = filterTrustedHooks(hooks, trusted);
    expect(allowed).toEqual([hooks[0]]);
    expect(untrusted).toEqual([hooks[1]]);
  });

  it("treats a missing or corrupt trust file as empty", async () => {
    const home = await tempHome();
    expect((await loadTrustedHookHashes(trustedHooksPath(home))).size).toBe(0);
    const corrupt = path.join(await tempHome(), "corrupt.json");
    await writeFile(corrupt, "not json");
    expect((await loadTrustedHookHashes(corrupt)).size).toBe(0);
  });
});

describe("hook audit", () => {
  it("appends jsonl records under the audit directory", async () => {
    const home = await tempHome();
    const audit = hookAuditPath(home);
    expect(audit).toContain(path.join("audit", "hooks.jsonl"));
    await appendHookAudit(audit, {
      timestamp: 1,
      event: "beforeTool",
      tool: "exec_command",
      commandHash: "h",
      command: "hook.cmd",
      outcome: "success",
      exitCode: 0,
      durationMs: 12,
    });
    await appendHookAudit(audit, {
      timestamp: 2,
      event: "sessionStart",
      commandHash: "h2",
      command: "other.cmd",
      outcome: "untrusted-blocked",
      durationMs: 0,
    });
    const lines = (await readFile(audit, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.outcome).toBe("success");
    expect(first.tool).toBe("exec_command");
    expect(JSON.parse(lines[1]!).outcome).toBe("untrusted-blocked");
  });
});
