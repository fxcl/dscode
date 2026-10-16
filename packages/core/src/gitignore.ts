import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

/**
 * gitignore awareness for the file tools. `list_files` and `search_files`
 * previously applied only DSCode's built-in ignores, so user-declared
 * .gitignore entries (build/, out/, *.log, ...) flooded listings and
 * searches. This module collects every .gitignore from the workspace root
 * and its subdirectories and rebases each rule to a workspace-relative glob
 * that fast-glob and ripgrep consume directly - no custom matcher needed.
 *
 * Deliberate boundaries: negation rules (`!keep/`) are DROPPED - neither
 * fast-glob's ignore option nor rg's --glob supports un-ignore semantics,
 * and the safe direction is showing more, never hiding more. .gitignore
 * files above the workspace root are not collected (recorded limitation).
 * Collected once per tool-factory lifetime; a mid-session .gitignore edit
 * needs a session restart. Design follows the documented command-code
 * gitignore mechanism in spirit; the collection shape fits DSCode's tools.
 */

export const GITIGNORE_PATTERN_CAP = 200;

const DISCOVERY_IGNORES = ["**/node_modules/**", "**/.git/**"];

export function parseGitignoreLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  if (trimmed.startsWith("!")) return undefined; // negation unsupported; see module notes
  if (trimmed === "/") return undefined;
  return trimmed;
}

/**
 * Rebase one rule from its .gitignore's directory to a workspace-relative
 * glob. A slash-less rule matches at any depth below its directory (git
 * semantics) - and at the root that must become an explicit double-star
 * glob, because fast-glob treats a bare star pattern as root-only.
 * Root-anchored rules ("/dist") pass through; subdirectory rules are
 * anchored under their directory.
 */
export function rebaseGitignoreRule(rule: string, relativeDir: string): string {
  const anchored = rule.startsWith("/");
  const body = anchored ? rule.slice(1) : rule;
  // Slash-less means no INTERNAL slash AND not root-anchored: a trailing
  // slash (`build/`) marks a directory, and `/dist` anchors to the
  // .gitignore's own directory - neither may gain a double-star prefix.
  const expands = !anchored && body.replace(/\/+$/, "").includes("/") === false;
  if (expands) {
    const base = relativeDir === "" || relativeDir === "." ? "" : `${relativeDir.replace(/[\\/]+$/, "")}/`;
    return `${base}**/${body}`;
  }
  if (relativeDir === "" || relativeDir === ".") return rule;
  return `${relativeDir.replace(/[\\/]+$/, "")}/${body}`;
}

export interface GitignoreCollection {
  patterns: string[];
  /** .gitignore files that contributed (diagnostics only). */
  sources: string[];
  truncated: boolean;
}

/**
 * Collect workspace-relative ignore globs from every .gitignore under the
 * workspace root. Best-effort: unreadable files are skipped silently.
 */
export async function collectGitignorePatterns(workspaceRoot: string): Promise<GitignoreCollection> {
  const sources = await fg("**/.gitignore", {
    cwd: workspaceRoot,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: DISCOVERY_IGNORES,
    unique: true,
  });
  sources.sort((a, b) => a.split("/").length - b.split("/").length);

  const patterns: string[] = [];
  let truncated = false;
  for (const source of sources) {
    if (patterns.length >= GITIGNORE_PATTERN_CAP) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await readFile(path.join(workspaceRoot, source), "utf8");
    } catch {
      continue;
    }
    const relativeDir = path.dirname(source).replace(/\\/g, "/");
    for (const line of content.split(/\r?\n/)) {
      if (patterns.length >= GITIGNORE_PATTERN_CAP) {
        truncated = true;
        break;
      }
      const rule = parseGitignoreLine(line);
      if (rule === undefined) continue;
      patterns.push(rebaseGitignoreRule(rule, relativeDir));
    }
  }
  return { patterns, sources, truncated };
}
