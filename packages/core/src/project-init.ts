import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve as resolvePath } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const ARTIFACT_DIRS = ["papers", "outputs", "experiments", "notes"];
const ARTIFACT_EXTS = new Set([
  ".md",
  ".tex",
  ".pdf",
  ".py",
  ".csv",
  ".json",
  ".html",
  ".txt",
  ".log",
]);

async function collectArtifacts(
  cwd: string,
): Promise<{ label: string; path: string }[]> {
  const items: { label: string; path: string; mtime: number }[] = [];

  for (const dir of ARTIFACT_DIRS) {
    const dirPath = resolvePath(cwd, dir);
    if (!(await pathExists(dirPath))) continue;

    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (
          ARTIFACT_EXTS.has(entry.name.slice(entry.name.lastIndexOf(".")))
        ) {
          const rel = relative(cwd, full);
          let title = "";
          try {
            const head = await readFile(full, "utf8").then((c) =>
              c.slice(0, 200),
            );
            const match = head.match(/^#\s+(.+)/m);
            if (match) title = match[1]!.trim();
          } catch {
            /* ignore */
          }
          const info = await stat(full).catch(() => null);
          const mtime = info?.mtimeMs ?? 0;
          const size = info ? formatSize(info.size) : "";
          const titlePart = title ? ` — ${title}` : "";
          items.push({
            label: `${rel}${titlePart}  (${size})`,
            path: rel,
            mtime,
          });
        }
      }
    };

    await walk(dirPath);
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function buildProjectAgentsTemplate(): string {
  return `# DSCode Project Guide

This file is read automatically at startup. It is the durable project memory for DSCode.

## Project Overview
- State the research question, target artifact, target venue, and key datasets or benchmarks here.

## AI Research Context
- Problem statement:
- Core hypothesis:
- Closest prior work:
- Required baselines:
- Required ablations:
- Primary metrics:
- Datasets / benchmarks:

## Ground Rules
- Do not modify raw data in \`Data/Raw/\` or equivalent raw-data folders.
- Read first, act second: inspect project structure and existing notes before making changes.
- Prefer durable artifacts in \`notes/\`, \`outputs/\`, \`experiments/\`, and \`papers/\`.
- Keep strong claims source-grounded. Include direct URLs in final writeups.

## Current Status
- Replace this section with the latest project status, known issues, and next steps.

## Task Ledger
- Track concrete tasks with IDs, owner, status, and output path.
- Mark tasks as \`todo\`, \`in_progress\`, \`done\`, \`blocked\`, or \`superseded\`.
- Do not silently merge or skip tasks; record the decision here.

## Verification Gates
- List the checks that must pass before delivery.
- For each critical claim, figure, or metric, record how it will be verified and where the raw artifact lives.
- Do not use words like \`verified\`, \`confirmed\`, or \`reproduced\` unless the underlying check actually ran.

## Honesty Contract
- Separate direct observations from inferences.
- If something is uncertain, say so explicitly.
- If a result looks cleaner than expected, assume it needs another check before it goes into the final artifact.

## Session Logging
- Use \`/log\` at the end of meaningful sessions to write a durable session note into \`notes/session-logs/\`.

## Review Readiness
- Known reviewer concerns:
- Missing experiments:
- Missing writing or framing work:
`;
}

export function buildSessionLogsReadme(): string {
  return `# Session Logs

Use \`/log\` to write one durable note per meaningful session.

Recommended contents:
- what was done
- strongest findings
- artifacts written
- unresolved questions
- next steps
`;
}

export function registerInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("init", {
    description:
      "Initialize AGENTS.md and session-log folders for a research project.",
    handler: async (_args, ctx) => {
      const agentsPath = resolvePath(ctx.cwd, "AGENTS.md");
      const notesDir = resolvePath(ctx.cwd, "notes");
      const sessionLogsDir = resolvePath(notesDir, "session-logs");
      const sessionLogsReadmePath = resolvePath(sessionLogsDir, "README.md");
      const created: string[] = [];
      const skipped: string[] = [];

      await mkdir(notesDir, { recursive: true });
      await mkdir(sessionLogsDir, { recursive: true });

      if (!(await pathExists(agentsPath))) {
        await writeFile(agentsPath, buildProjectAgentsTemplate(), "utf8");
        created.push("AGENTS.md");
      } else {
        skipped.push("AGENTS.md");
      }

      if (!(await pathExists(sessionLogsReadmePath))) {
        await writeFile(sessionLogsReadmePath, buildSessionLogsReadme(), "utf8");
        created.push("notes/session-logs/README.md");
      } else {
        skipped.push("notes/session-logs/README.md");
      }

      const createdSummary =
        created.length > 0 ? `created: ${created.join(", ")}` : "created: nothing";
      const skippedSummary =
        skipped.length > 0 ? `; kept existing: ${skipped.join(", ")}` : "";
      ctx.ui.notify(`${createdSummary}${skippedSummary}`, "info");
    },
  });
}

export function registerOutputsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("outputs", {
    description:
      "Browse all research artifacts (papers, outputs, experiments, notes).",
    handler: async (_args, ctx) => {
      const items = await collectArtifacts(ctx.cwd);
      if (items.length === 0) {
        ctx.ui.notify(
          "No artifacts found. Create papers, outputs, experiments, or notes to get started.",
          "info",
        );
        return;
      }

      const selected = await ctx.ui.select(
        `Artifacts (${items.length})`,
        items.map((i) => i.label),
      );
      if (!selected) return;

      const match = items.find((i) => i.label === selected);
      if (match) {
        ctx.ui.setEditorText(`read ${match.path}`);
        ctx.ui.notify(`Prefilled: read ${match.path}`, "info");
      }
    },
  });
}
