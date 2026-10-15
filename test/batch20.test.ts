import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectEnvironmentContext,
  collectStructure,
  renderEnvironmentContext,
  resolveMainBranchName,
} from "../packages/core/src/env-context.js";
import {
  acquireInstanceLock,
  instanceLockPathFor,
  isProcessAlive,
  parseLockFile,
  readInstanceLock,
  releaseInstanceLock,
  watchInstanceLock,
} from "../packages/core/src/instance-lock.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-"));
  tempDirs.push(root);
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "batch20@example.test"]);
  run(["config", "user.name", "Batch 20"]);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content, "utf8");
  }
  run(["add", "."]);
  run(["commit", "--allow-empty", "-m", "initial commit"]);
  return root;
}

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

describe("batch 20 — environment context collection", () => {
  it("collects git facts from a real repository", { timeout: 60_000 }, async () => {
    const root = await makeRepo({ "src/index.ts": "export {};\n" });
    const context = await collectEnvironmentContext(root);
    expect(context.isGitRepo).toBe(true);
    expect(context.currentBranch).toBe("main");
    expect(context.workingDir).toBe(root);
    expect(context.platform).toContain(process.platform);
    expect(context.structure).toContain("src/");
    expect(context.gitStatus).toBe("");
    expect(context.recentCommits.length).toBe(1);
    expect(context.recentCommits[0]).toContain("initial commit");
  });

  it("reports a dirty tree through porcelain status", { timeout: 60_000 }, async () => {
    const root = await makeRepo();
    await writeFile(path.join(root, "dirty.txt"), "changed", "utf8");
    const context = await collectEnvironmentContext(root);
    expect(context.gitStatus).toContain("?? dirty.txt");
  });

  it("handles a non-git directory without inventing facts", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-nogit-"));
    tempDirs.push(root);
    const context = await collectEnvironmentContext(root);
    expect(context.isGitRepo).toBe(false);
    expect(context.currentBranch).toBe("");
    expect(context.gitStatus).toBe("");
    expect(context.recentCommits).toEqual([]);
  });

  it("resolves origin/HEAD over an existing main", { timeout: 60_000 }, async () => {
    const root = await makeRepo();
    gitIn(root, ["branch", "develop"]);
    gitIn(root, ["remote", "add", "origin", "https://example.test/repo.git"]);
    gitIn(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/develop"]);
    expect(await resolveMainBranchName(root)).toBe("develop");
  });

  it("caps the porcelain listing when the tree is very dirty", { timeout: 60_000 }, async () => {
    const root = await makeRepo();
    for (let index = 0; index < 60; index += 1) {
      await writeFile(path.join(root, `noise-${index}.txt`), "x", "utf8");
    }
    const context = await collectEnvironmentContext(root);
    const lines = context.gitStatus.split("\n");
    expect(lines.length).toBe(51);
    expect(context.gitStatus).toContain("and 10 more");
  });

  it("caps and orders the structure listing (directories first)", { timeout: 60_000 }, async () => {
    const root = await makeRepo({ "zz-file.txt": "x", "aa-file.txt": "x" });
    await mkdir(path.join(root, "zz-dir"));
    await mkdir(path.join(root, "aa-dir"));
    const structure = await collectStructure(root);
    expect(structure.indexOf("aa-dir/")).toBeLessThan(structure.indexOf("zz-dir/"));
    expect(structure.indexOf("aa-dir/")).toBeLessThan(structure.indexOf("aa-file.txt"));
    expect(structure).not.toContain(".git/");
  });
});

describe("batch 20 — environment context rendering", () => {
  it("renders the git section with branch, status, and commits", () => {
    const text = renderEnvironmentContext({
      workingDir: "D:\\repo",
      date: "2026-10-15",
      platform: "win32 / x64",
      structure: ["src/", "package.json"],
      isGitRepo: true,
      currentBranch: "feat/port",
      mainBranch: "main",
      gitStatus: " M src/a.ts",
      recentCommits: ["abc1234 add a", "def5678 init"],
    });
    expect(text).toContain("Working directory: D:\\repo");
    expect(text).toContain("Current branch: feat/port");
    expect(text).toContain("Main branch (you will usually target this for PRs): main");
    expect(text).toContain(" M src/a.ts");
    expect(text).toContain("Recent commits:");
    expect(text).toContain("abc1234 add a");
  });

  it("renders a clean tree explicitly and skips git facts outside a repo", () => {
    const clean = renderEnvironmentContext({
      workingDir: "/repo",
      date: "2026-10-15",
      platform: "linux / arm64",
      structure: [],
      isGitRepo: true,
      currentBranch: "main",
      mainBranch: "main",
      gitStatus: "",
      recentCommits: [],
    });
    expect(clean).toContain("Working tree clean");
    expect(clean).not.toContain("Recent commits:");

    const plain = renderEnvironmentContext({
      workingDir: "/tmp",
      date: "2026-10-15",
      platform: "linux / arm64",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    });
    expect(plain).not.toContain("Current branch");
    expect(plain).toContain("Platform: linux / arm64");
  });
});

describe("batch 20 — instance lock", () => {
  it("reports liveness including the EPERM-means-alive case", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it("parses lock files and tolerates corruption", () => {
    expect(parseLockFile(`{"pid": 42, "cwd": "/x", "startedAt": "t"}\n`)).toMatchObject({ pid: 42, cwd: "/x" });
    expect(parseLockFile("{\"pid\": 42}")).toBeUndefined();
    expect(parseLockFile("not json")).toBeUndefined();
  });

  it("acquires exclusively and refuses when a live holder exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-lock-"));
    tempDirs.push(root);
    const lockPath = instanceLockPathFor(root);
    const first = await acquireInstanceLock(lockPath, { pid: process.pid, cwd: root, startedAt: "t0" });
    expect(first.ok).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    const second = await acquireInstanceLock(lockPath, { pid: process.pid + 50_000, cwd: root, startedAt: "t1" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder.pid).toBe(process.pid);
  });

  it("steals the lock of a dead holder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-lock-"));
    tempDirs.push(root);
    const lockPath = instanceLockPathFor(root);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 999_999_999, cwd: root, startedAt: "dead", version: 1 }, null, 2)}\n`,
      "utf8",
    );
    const outcome = await acquireInstanceLock(lockPath, { pid: process.pid, cwd: root, startedAt: "alive" });
    expect(outcome.ok).toBe(true);
    const info = await readInstanceLock(lockPath);
    expect(info?.pid).toBe(process.pid);
  });

  it("treats a corrupt lock file as absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-lock-"));
    tempDirs.push(root);
    const lockPath = instanceLockPathFor(root);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "{ truncated", "utf8");
    expect(await readInstanceLock(lockPath)).toBeUndefined();
    const outcome = await acquireInstanceLock(lockPath, { pid: process.pid, cwd: root, startedAt: "t" });
    expect(outcome.ok).toBe(true);
  });

  it("releases only our own lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-lock-"));
    tempDirs.push(root);
    const lockPath = instanceLockPathFor(root);
    await acquireInstanceLock(lockPath, { pid: process.pid, cwd: root, startedAt: "mine" });
    await releaseInstanceLock(lockPath, process.pid + 77_777);
    expect(existsSync(lockPath)).toBe(true);
    await releaseInstanceLock(lockPath, process.pid);
    expect(existsSync(lockPath)).toBe(false);
    // Releasing a released lock stays silent.
    await releaseInstanceLock(lockPath, process.pid);
  });

  it("reports loss when another live pid takes over the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-lock-"));
    tempDirs.push(root);
    const lockPath = instanceLockPathFor(root);
    await acquireInstanceLock(lockPath, { pid: process.pid, cwd: root, startedAt: "mine" });

    let lostWith: number | undefined;
    const watch = watchInstanceLock(
      lockPath,
      process.pid,
      (holder) => {
        lostWith = holder.pid;
      },
      50,
    );
    try {
      // A live successor takes over: takeover is a plain overwrite, the
      // watcher must notice on its next poll.
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid + 1, cwd: root, startedAt: "successor", version: 1 }, null, 2)}\n`,
        "utf8",
      );
      const deadline = Date.now() + 3_000;
      while (lostWith === undefined && Date.now() < deadline) {
        await delay(50);
      }
      expect(lostWith).toBe(process.pid + 1);
    } finally {
      watch.stop();
    }
  });

  it("keeps lock contents readable for diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b20-lock-"));
    tempDirs.push(root);
    const lockPath = instanceLockPathFor(root);
    await acquireInstanceLock(lockPath, { pid: process.pid, cwd: root, startedAt: "t" });
    const raw = await readFile(lockPath, "utf8");
    expect(raw).toContain(`"pid": ${process.pid}`);
    expect(raw).toContain(`"cwd": ${JSON.stringify(root)}`);
  });
});
