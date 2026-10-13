import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";

/**
 * MCP tool-description synthesis: third-party MCP tools often ship verbose
 * descriptions that sit in the model-facing catalog forever. This runs once
 * per (server, tool, description) triple on the background lane model and
 * caches the result on disk, so the model sees one tight sentence instead of
 * a page of prose.
 */

const CACHE_VERSION = 1;
/** Descriptions shorter than this are already tight — leave them alone. */
export const MIN_RAW_DESCRIPTION_CHARS = 160;
/** synthesized output cap; longer results are rejected. */
export const MAX_SYNTHESIZED_CHARS = 320;
/** Cap per connect so a 40-tool server cannot stall startup. */
export const MAX_SYNTHESIZE_PER_CONNECT = 12;

export function descriptionCacheKey(
  serverName: string,
  toolName: string,
  rawDescription: string,
): string {
  return createHash("sha256")
    .update(`${CACHE_VERSION}|${serverName}|${toolName}|${rawDescription}`)
    .digest("hex")
    .slice(0, 20);
}

export async function loadDescriptionCache(
  cachePath: string,
): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as
      | { version?: unknown; entries?: unknown }
      | null;
    if (parsed && typeof parsed === "object" && parsed.version === CACHE_VERSION) {
      const entries = parsed.entries;
      if (entries && typeof entries === "object") {
        return Object.fromEntries(
          Object.entries(entries as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    }
  } catch {
    // no cache yet
  }
  return {};
}

export async function saveDescriptionCache(
  cachePath: string,
  cache: Record<string, string>,
): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify({ version: CACHE_VERSION, entries: cache }, null, 2)}\n`,
    "utf8",
  );
}

/** A synthesis is valid when it is a tight single-line summary, strictly shorter than the raw text. */
export function isValidSynthesis(text: string, rawDescription: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20 || trimmed.length > MAX_SYNTHESIZED_CHARS) return false;
  if (trimmed.length >= rawDescription.length) return false;
  if (/^(i |sorry|as an? )/i.test(trimmed)) return false;
  return true;
}

/** System prompt for the description compressor (original wording). */
export function describeSystemPrompt(): string {
  return [
    "You compress tool descriptions for a coding agent's model-facing tool",
    "catalog. Given one third-party tool description, output a single",
    `replacement of at most ${MAX_SYNTHESIZED_CHARS} characters that preserves: what the`,
    "tool does, its most important parameters, and any critical constraint",
    "(destructive behavior, network access, required formats).",
    "Never add capabilities the description does not mention.",
    "Output only the replacement sentence — no preamble, no quotes.",
  ].join("\n");
}

export interface SynthesisTarget {
  name: string;
  description: string;
}

export interface SynthesizeToolDescriptionsInput {
  serverName: string;
  tools: readonly SynthesisTarget[];
  models: Pick<Models, "complete">;
  model: Model<any>;
  cachePath: string;
  signal?: AbortSignal | undefined;
}

/**
 * Return a map of tool name → synthesized description for tools whose raw
 * description is worth compressing. Cache hits are free; misses hit the lane
 * model with a hard per-connect cap. Any failure simply yields fewer entries.
 */
export async function synthesizeToolDescriptions(
  input: SynthesizeToolDescriptionsInput,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const cache = await loadDescriptionCache(input.cachePath);
  const misses: SynthesisTarget[] = [];

  for (const tool of input.tools) {
    if (tool.description.length < MIN_RAW_DESCRIPTION_CHARS) continue;
    const key = descriptionCacheKey(input.serverName, tool.name, tool.description);
    const cached = cache[key];
    if (cached !== undefined) {
      result.set(tool.name, cached);
      continue;
    }
    if (misses.length < MAX_SYNTHESIZE_PER_CONNECT) misses.push(tool);
  }

  for (const tool of misses) {
    if (input.signal?.aborted) break;
    try {
      const response = await input.models.complete(
        input.model,
        {
          systemPrompt: describeSystemPrompt(),
          messages: [
            {
              role: "user",
              content: `Tool: ${input.serverName}.${tool.name}\n\nDescription to compress:\n${tool.description}`,
              timestamp: Date.now(),
            } as never,
          ],
        },
        input.signal ? { signal: input.signal } : undefined,
      );
      const text =
        typeof response.content === "string"
          ? response.content
          : Array.isArray(response.content)
            ? response.content
                .filter(
                  (block): block is { type: "text"; text: string } =>
                    typeof block === "object" &&
                    block !== null &&
                    (block as { type?: unknown }).type === "text" &&
                    typeof (block as { text?: unknown }).text === "string",
                )
                .map((block) => block.text)
                .join("")
          : "";
      if (!isValidSynthesis(text, tool.description)) continue;
      const synthesized = text.trim();
      const key = descriptionCacheKey(input.serverName, tool.name, tool.description);
      cache[key] = synthesized;
      result.set(tool.name, synthesized);
    } catch {
      // synthesis is best-effort; raw description stays in place
    }
  }

  if (misses.length > 0) {
    try {
      await saveDescriptionCache(input.cachePath, cache);
    } catch {
      // cache write is best-effort
    }
  }
  return result;
}
