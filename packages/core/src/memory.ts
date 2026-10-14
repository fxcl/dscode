import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Memory files: layered AGENTS.md/CLAUDE.md instructions with an @import
 * expansion syntax and @mention-activated nested memory. Ported from the
 * documented command-code mechanism; wording and structure are original.
 *
 * Layers (each rendered as "# Memory from: <path>" blocks, joined by "---"):
 *   user     ~/.dscode/AGENTS.md
 *   project  first existing of <cwd>/AGENTS.md, <cwd>/CLAUDE.md, <cwd>/.dscode/AGENTS.md
 *   nested   for every @mentioned file under cwd: the first existing memory
 *            file at each ancestor directory between cwd and the mention
 *
 * Inside any memory file, a whitespace-anchored `@path` mention inlines the
 * referenced file (~/ expands to home, relative paths resolve against the
 * mentioning file's directory, fenced code and inline code are exempt,
 * imports nest up to MEMORY_IMPORT_MAX_DEPTH, unresolvable mentions are left
 * as written).
 */

export const MEMORY_IMPORT_MAX_DEPTH = 5;
/** Per-file content cap so a stray huge memory file cannot flood the prompt. */
export const MEMORY_FILE_MAX_CHARS = 32_000;

const PROJECT_MEMORY_CANDIDATES = ["AGENTS.md", "CLAUDE.md", path.join(".dscode", "AGENTS.md")];
const MENTION_RE = /@(?:"([^"]+)"|([^\s@]+))/g;
const IMPORT_RE = /(?:^|[\s\n])@((?:~\/)?[^\s\n]+(?:\.[^\s\n]+)?)/gm;

export interface MemoryBlock {
  source: string;
  content: string;
}

async function readMemoryFile(candidate: string): Promise<MemoryBlock | undefined> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return undefined;
    let content = await readFile(candidate, "utf8");
    if (!content.trim()) return undefined;
    if (content.length > MEMORY_FILE_MAX_CHARS) content = content.slice(0, MEMORY_FILE_MAX_CHARS);
    return { source: candidate, content };
  } catch {
    return undefined;
  }
}

/** First existing project memory file at a directory, in candidate order. */
async function projectMemoryAt(dir: string): Promise<MemoryBlock | undefined> {
  for (const name of PROJECT_MEMORY_CANDIDATES) {
    const block = await readMemoryFile(path.join(dir, name));
    if (block) return block;
  }
  return undefined;
}

/** Extract @mentioned paths (quoted or bare) from user message texts. */
export function extractMentionedPaths(userTexts: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of userTexts) {
    for (const match of text.matchAll(MENTION_RE)) {
      const mention = match[1] ?? match[2];
      if (mention) found.push(mention);
    }
  }
  return found;
}

function maskCodeRegions(content: string): { text: string; restore: (text: string) => string } {
  const regions: string[] = [];
  const masked = content
    .replace(/```[\s\S]*?```/g, (region) => {
      regions.push(region);
      return `__DSCodeMemoryCodeBlock_${regions.length - 1}__`;
    })
    .replace(/`[^`\n]*`/g, (region) => {
      regions.push(region);
      return `__DSCodeMemoryCodeSpan_${regions.length - 1}__`;
    });
  return {
    text: masked,
    restore: (text) => text.replaceAll(/__DSCodeMemoryCode(?:Block|Span)_(\d+)__/g, (_m, index) => regions[Number(index)] ?? ""),
  };
}

async function resolveMentionTarget(mention: string, baseDir: string, home: string): Promise<string | undefined> {
  if (mention.startsWith("~/")) return path.join(home, mention.slice(2));
  if (path.isAbsolute(mention)) return mention;
  return path.resolve(baseDir, mention);
}

/**
 * Recursively expand @import mentions inside a memory file's content.
 * Unresolvable mentions are left untouched; nesting is capped.
 */
export async function expandMemoryImports(
  content: string,
  baseDir: string,
  home: string = os.homedir(),
  depth = 0,
): Promise<string> {
  if (depth >= MEMORY_IMPORT_MAX_DEPTH) return content;
  const { text: masked, restore } = maskCodeRegions(content);
  const expanded = await replaceAsync(masked, IMPORT_RE, async (_match, ...groups: unknown[]) => {
    const mention = groups[0] as string;
    if (!mention) return _match;
    const target = await resolveMentionTarget(mention, baseDir, home);
    if (!target) return _match;
    const imported = await readMemoryFile(target);
    if (!imported) return _match;
    const nested = await expandMemoryImports(imported.content, path.dirname(target), home, depth + 1);
    return `\n# Imported from ${mention}\n${nested}\n`;
  });
  return restore(expanded);
}

async function replaceAsync(
  text: string,
  regex: RegExp,
  replacer: (match: string, ...groups: unknown[]) => Promise<string>,
): Promise<string> {
  const jobs: Array<Promise<string>> = [];
  text.replace(regex, (match, ...groups) => {
    jobs.push(replacer(match, ...groups));
    return match;
  });
  const results = await Promise.all(jobs);
  let index = 0;
  return text.replace(regex, () => results[index++] ?? "");
}

/**
 * Load the memory context for a session: user layer, project layer, then
 * mention-activated nested layers, @imports expanded, deduped by path.
 * Returns undefined when nothing exists.
 */
export async function loadMemoryContext(options: {
  cwd: string;
  home?: string;
  mentionedPaths?: readonly string[];
}): Promise<string | undefined> {
  const home = options.home ?? os.homedir();
  const cwd = path.resolve(options.cwd);
  const blocks: MemoryBlock[] = [];
  const seen = new Set<string>();

  const push = async (block: MemoryBlock | undefined, expandBase?: string): Promise<void> => {
    if (!block || seen.has(block.source)) return;
    seen.add(block.source);
    blocks.push({
      source: block.source,
      content: await expandMemoryImports(block.content, expandBase ?? path.dirname(block.source), home),
    });
  };

  // User layer: personal memory across all projects.
  await push(await readMemoryFile(path.join(home, ".dscode", "AGENTS.md")));
  // Project layer: first existing candidate at the workspace root.
  await push(await projectMemoryAt(cwd));

  // Mention-activated nested layers: ancestors between cwd and each
  // mentioned file, outermost first.
  for (const mention of options.mentionedPaths ?? []) {
    const absolute = path.isAbsolute(mention) ? mention : path.resolve(cwd, mention);
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile()) continue;
    const relative = path.relative(cwd, path.dirname(absolute));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const segments = relative.split(path.sep).filter(Boolean);
    let current = cwd;
    for (const segment of segments) {
      current = path.join(current, segment);
      await push(await projectMemoryAt(current));
    }
  }

  if (blocks.length === 0) return undefined;
  return blocks.map((block) => `# Memory from: ${block.source}\n\n${block.content}`).join("\n\n---\n\n");
}
