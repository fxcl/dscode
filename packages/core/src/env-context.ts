import { readdir } from "node:fs/promises";
import { runProcess } from "./process.js";
import { gitSafeArgs, gitSafeEnv } from "./git-safe.js";

/**
 * Environment context: a block of ground-truth session facts (working
 * directory, date, platform, top-level structure, and for git repositories
 * the current branch, main branch, porcelain status, and the last three
 * commits) collected once per session and injected into the system prompt.
 * Without it, every git-adjacent answer starts with a round of status
 * probing. Collected ONCE, not per turn - it is orientation, not live state.
 * Design follows the documented command-code env-context mechanism; all
 * wording is original.
 */

export interface EnvironmentContext {
  workingDir: string;
  date: string;
  platform: string;
  structure: string[];
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  /** Porcelain status lines, capped; empty string means a clean tree. */
  gitStatus: string;
  recentCommits: string[];
}

const STATUS_LINE_CAP = 50;
const STRUCTURE_ENTRY_CAP = 30;

async function gitOutput(cwd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const result = await runProcess("git", gitSafeArgs(args), {
    cwd,
    envOverlay: gitSafeEnv(),
    timeoutMs,
    maxOutputBytes: 40_000,
  });
  if (result.exitCode !== 0) return "";
  return result.stdout.trim();
}

/** Resolve the main branch: origin/HEAD when set, else an existing main/master. */
export async function resolveMainBranchName(cwd: string): Promise<string> {
  const originHead = await gitOutput(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (originHead) {
    // --short abbreviates refs/heads/x to "x" and refs/remotes/origin/x to
    // "origin/x" — accept both shapes; the branch exists either way.
    return originHead.startsWith("origin/") ? originHead.slice("origin/".length) : originHead;
  }
  for (const candidate of ["main", "master"]) {
    if (await gitOutput(cwd, ["show-ref", "--verify", `refs/heads/${candidate}`])) return candidate;
  }
  return "";
}

/** Top-level entries (directories first, then files), capped for the prompt. */
export async function collectStructure(cwd: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(cwd, { withFileTypes: true });
    const directories = dirents
      .filter((entry) => entry.isDirectory() && entry.name !== ".git")
      .map((entry) => `${entry.name}/`)
      .sort((a, b) => a.localeCompare(b));
    const files = dirents
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    entries = [...directories, ...files].slice(0, STRUCTURE_ENTRY_CAP);
  } catch {
    entries = [];
  }
  return entries;
}

/** Collect the session's environment facts. All git probes are best-effort. */
export async function collectEnvironmentContext(cwd: string, now = new Date()): Promise<EnvironmentContext> {
  const structure = await collectStructure(cwd);
  const gitDir = await gitOutput(cwd, ["rev-parse", "--git-dir"]);
  const base: EnvironmentContext = {
    workingDir: cwd,
    date: now.toISOString().slice(0, 10),
    platform: `${process.platform} / ${process.arch}`,
    structure,
    isGitRepo: gitDir !== "",
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
  if (!base.isGitRepo) return base;

  const [currentBranch, mainBranch, porcelain, log] = await Promise.all([
    gitOutput(cwd, ["branch", "--show-current"]),
    resolveMainBranchName(cwd),
    gitOutput(cwd, ["status", "--porcelain"]),
    gitOutput(cwd, ["log", "--oneline", "-3"]),
  ]);
  const statusLines = porcelain ? porcelain.split("\n") : [];
  return {
    ...base,
    currentBranch,
    mainBranch,
    gitStatus: statusLines.length > 0
      ? statusLines.slice(0, STATUS_LINE_CAP).join("\n") +
        (statusLines.length > STATUS_LINE_CAP ? `\n... and ${statusLines.length - STATUS_LINE_CAP} more` : "")
      : "",
    recentCommits: log ? log.split("\n").filter(Boolean) : [],
  };
}

/**
 * Render the injected block. The git section states the facts without
 * instructions beyond the one convention worth teaching (PRs target the
 * main branch).
 */
export function renderEnvironmentContext(context: EnvironmentContext): string {
  const gitSection = context.isGitRepo
    ? [
        "",
        `Current branch: ${context.currentBranch || "(detached HEAD)"}`,
        `Main branch (you will usually target this for PRs): ${context.mainBranch || "(unresolved)"}`,
        "",
        "Status:",
        context.gitStatus || "Working tree clean",
        ...(context.recentCommits.length > 0 ? ["", "Recent commits:", ...context.recentCommits] : []),
      ].join("\n")
    : "";
  return [
    "# Environment",
    "",
    `Working directory: ${context.workingDir}`,
    `Date: ${context.date}`,
    `Platform: ${context.platform}`,
    context.structure.length > 0 ? `Top-level entries: ${context.structure.join(", ")}` : "",
    gitSection,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Convenience used by tests and callers holding a repo root other than cwd. */
export function isGitRepoContext(context: EnvironmentContext): boolean {
  return context.isGitRepo;
}
