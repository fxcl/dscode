import { open, readdir, stat, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { HistorySessionInfo } from '../shared/types'
import { defaultPiAgentDir } from './piSettings'

/**
 * Read-only access to the runtime's on-disk session files.
 *
 * DSCode layout (~/.dscode/sessions): transcripts are written FLAT by the
 * pi runtime and then moved into date partitions by dscode, keeping a flat
 * hard-link for pi's resume implementation:
 *
 *   sessions/<ts>_<uuid>.jsonl            (flat hard-link, same inode)
 *   sessions/YYYY/MM/DD/<ts>_<uuid>.jsonl (canonical partitioned copy)
 *
 * There are no per-project directories; the project association lives in
 * each file's header line:
 *   {"type":"session","version":3,"id","timestamp","cwd"}
 * So project history = walk the tree, parse headers, filter by cwd.
 * Hard-linked duplicates are deduped by session id.
 */

/** Bytes of a session file scanned for the first user message (title source). */
const TITLE_SCAN_BYTES = 256 * 1024

/** Title fallback for sessions without a user message. */
const UNTITLED = 'Untitled'

export function sessionsRoot(agentDir: string = defaultPiAgentDir()): string {
  return path.join(agentDir, 'sessions')
}

/**
 * Guard for destructive/resume operations: the resolved path must be a
 * .jsonl file inside the sessions root (any project's directory within it),
 * and — crucially — its REAL path must also land inside the sessions root, so a
 * `session.jsonl -> /outside/file` symlink can never be read/resumed as a
 * transcript (or deleted through to its outside target).
 */
export function isSessionFilePath(
  filePath: string,
  agentDir: string = defaultPiAgentDir()
): boolean {
  if (typeof filePath !== 'string' || !filePath.endsWith('.jsonl')) return false
  const root = path.resolve(sessionsRoot(agentDir))
  const resolved = path.resolve(filePath)
  // Fast lexical reject first.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false
  // Realpath containment: when the file exists, its real path must stay inside
  // the sessions root — a `session.jsonl -> /outside/file` symlink is rejected.
  // A missing/broken target has nothing to follow (no symlink-escape risk), so
  // the lexical check above already suffices there.
  try {
    const rootReal = realpathSync(root)
    const fileReal = realpathSync(resolved)
    return fileReal === rootReal || fileReal.startsWith(rootReal + path.sep)
  } catch {
    return true
  }
}

/** Read at most `bytes` from the start of a file. */
async function readHead(filePath: string, bytes: number): Promise<string> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.toString('utf-8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Join the text blocks of an AgentMessage content array (or plain string). */
function textContentOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Parse one session file: the session header for id/timestamp/cwd, then the
 * first user message (within TITLE_SCAN_BYTES) for the title. Returns null
 * for files without a parseable session header.
 *
 * Header position is deliberately not pinned to line 0: legacy pi opens the
 * file with {"type":"session",…} directly, current omp prepends a
 * {"type":"title",…} line. Scan the first few lines for the header instead.
 */
async function parseSessionFile(filePath: string): Promise<HistorySessionInfo | null> {
  let head: string
  try {
    head = await readHead(filePath, TITLE_SCAN_BYTES)
  } catch {
    return null
  }
  const lines = head.split('\n')
  let header: { id: string; timestamp?: unknown; cwd?: unknown } | null = null
  let headerIndex = -1
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (!lines[i].trim()) continue
    let candidate: { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown }
    try {
      candidate = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (candidate?.type === 'session' && typeof candidate.id === 'string') {
      header = { id: candidate.id, timestamp: candidate.timestamp, cwd: candidate.cwd }
      headerIndex = i
      break
    }
  }
  if (!header) return null

  let timestamp =
    typeof header.timestamp === 'number' ? header.timestamp : Date.parse(String(header.timestamp))
  if (!Number.isFinite(timestamp)) {
    // Header without a usable timestamp — fall back to the file's mtime.
    timestamp = await stat(filePath).then((s) => s.mtimeMs, () => 0)
  }

  let title = UNTITLED
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type === 'message' && entry.message?.role === 'user') {
      const text = textContentOf(entry.message.content).replace(/\s+/g, ' ').trim()
      if (text) {
        title = text.slice(0, 80)
        break
      }
    }
  }

  return {
    uuid: header.id,
    filePath,
    title,
    timestamp,
    cwd: typeof header.cwd === 'string' ? header.cwd : ''
  }
}

/**
 * Every .jsonl under the sessions root (flat + date partitions), up to a
 * bounded depth so a runaway tree can't stall the walk.
 */
async function walkSessionFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    let names: import('node:fs').Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full)
      } else if (entry.isDirectory() && depth < 3) {
        await visit(full, depth + 1)
      }
    }
  }
  await visit(root, 0)
  return out
}

/** Realpath of a directory, falling back to the resolved path. */
function dirRealPath(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/**
 * List persisted sessions of a project, newest first.
 * Files are filtered by the session header's cwd (realpath-compared so
 * /tmp vs /private/tmp style aliases match); hard-linked duplicates (flat
 * link + date partition of the same transcript) are deduped by session id.
 */
export async function listSessionHistory(
  projectDir: string,
  agentDir?: string
): Promise<HistorySessionInfo[]> {
  const root = sessionsRoot(agentDir ?? defaultPiAgentDir())
  const files = await walkSessionFiles(root)
  const wantCwd = dirRealPath(projectDir)
  const byId = new Map<string, HistorySessionInfo>()
  for (const file of files) {
    const info = await parseSessionFile(file)
    if (!info || !info.cwd) continue
    if (dirRealPath(info.cwd) !== wantCwd) continue
    const existing = byId.get(info.uuid)
    if (!existing || info.timestamp > existing.timestamp) {
      byId.set(info.uuid, info)
    }
  }
  const out = [...byId.values()]
  out.sort((a, b) => b.timestamp - a.timestamp)
  return out
}

/**
 * Delete a session transcript; guarded to .jsonl files inside the sessions
 * root. dscode keeps a flat hard-link and a date-partitioned copy of every
 * transcript — both share one inode, so every path with the same inode is
 * removed to actually delete the session.
 */
export async function deleteSessionFile(filePath: string, agentDir?: string): Promise<boolean> {
  if (!isSessionFilePath(filePath, agentDir ?? defaultPiAgentDir())) return false
  let removed = false
  const unlinkQuiet = async (file: string): Promise<void> => {
    try {
      await unlink(file)
      removed = true
    } catch {
      // already gone — fine
    }
  }
  try {
    const target = await stat(filePath)
    await unlinkQuiet(filePath)
    // Sweep hard-link siblings (same dev+ino) elsewhere in the tree.
    const root = sessionsRoot(agentDir ?? defaultPiAgentDir())
    for (const file of await walkSessionFiles(root)) {
      let s: import('node:fs').Stats
      try {
        s = await stat(file)
      } catch {
        continue
      }
      if (s.dev === target.dev && s.ino === target.ino) {
        await unlinkQuiet(file)
      }
    }
  } catch {
    return removed
  }
  return removed
}
