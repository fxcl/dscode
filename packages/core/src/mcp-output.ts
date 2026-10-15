import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * MCP result output budget: an MCP tool can return megabytes, and the model
 * context is not where that belongs. Text above the token budget is spilled
 * to a temp file the model can read on demand; binary and image payloads are
 * persisted to disk instead of being base64-flooded into context. Ported from
 * the documented command-code registry behavior; wording original.
 */

export const MCP_OUTPUT_TOKEN_LIMIT = 25_000;
/** Rough chars-per-token used for the estimate (matches the guard in core). */
const CHARS_PER_TOKEN = 4;
/** Flat token cost for a non-text block (image or binary resource). */
export const IMAGE_BLOCK_TOKEN_ESTIMATE = 1_600;

const SPILL_DIR = path.join(os.tmpdir(), "dscode-mcp-outputs");
let spillDirReady = false;

export function mcpOutputTokenLimit(): number {
  const raw = process.env.MCP_OUTPUT_TOKEN_LIMIT?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return MCP_OUTPUT_TOKEN_LIMIT;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface McpOutputOutcome {
  text: string;
  /** Number of image blocks that were persisted to disk instead of inlined. */
  imagesSpilled: number;
  /** Whether the text overflowed and was spilled. */
  spilled: boolean;
}

/**
 * Enforce the output budget on the final text. When over budget, the full
 * text is written to a temp file and the returned text is capped with a
 * pointer + continuation advice.
 */
export async function enforceMcpOutputLimit(
  serverName: string,
  text: string,
  limitTokens: number = mcpOutputTokenLimit(),
): Promise<McpOutputOutcome> {
  const tokens = estimateTextTokens(text);
  if (tokens <= limitTokens) {
    return { text, imagesSpilled: 0, spilled: false };
  }
  const spillPath = await spillText(serverName, text);
  const keepChars = limitTokens * CHARS_PER_TOKEN;
  const capped =
    text.slice(0, keepChars) +
    `\n[OUTPUT TRUNCATED — exceeded the ${limitTokens.toLocaleString()}-token MCP output limit]` +
    `\n[full output saved to: ${spillPath} — read it with read_file (offset/limit) or grep]`;
  return { text: capped, imagesSpilled: 0, spilled: true };
}

/** Persist an image/binary payload and return the human-facing pointer. */
export async function persistBinaryPayload(
  serverName: string,
  mimeType: string,
  base64: string,
): Promise<string> {
  await ensureSpillDir();
  const file = path.join(
    SPILL_DIR,
    `mcp-${sanitize(serverName)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extensionForMimeType(mimeType)}`,
  );
  await writeFile(file, Buffer.from(base64, "base64"));
  const size = Buffer.byteLength(base64, "base64");
  return `Binary content (${mimeType}, ${formatByteSize(size)}) saved to ${file} — read or open it from disk; it was not placed into context.`;
}

async function spillText(serverName: string, text: string): Promise<string> {
  await ensureSpillDir();
  const file = path.join(
    SPILL_DIR,
    `mcp-${sanitize(serverName)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  await writeFile(file, text, "utf8");
  return file;
}

async function ensureSpillDir(): Promise<void> {
  if (!spillDirReady) {
    await mkdir(SPILL_DIR, { recursive: true });
    spillDirReady = true;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^\w-]/g, "_").slice(0, 40) || "server";
}

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

export function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return MIME_EXTENSIONS[base] ?? ".bin";
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}
