import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// sessionHistory.ts imports ./piSettings, which imports ./omp for CLI
// detection — tests always pass an explicit agentDir, so stub it out
// electron-free (same pattern as piSettings.test.ts).
vi.mock('../omp', () => ({
  detectCli: () => ({ command: 'dscode', path: '/usr/local/bin/dscode', available: true }),
  executableSearchDirs: () => []
}))

import {
  sessionsRoot,
  listSessionHistory,
  deleteSessionFile,
  isSessionFilePath
} from '../sessionHistory'

let agentDir: string
let projectDir: string

beforeEach(() => {
  agentDir = mkdtempSync(path.join(tmpdir(), 'dscode-agent-'))
  projectDir = mkdtempSync(path.join(tmpdir(), 'dscode-project-'))
})

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

function sessionHeader(id: string, timestamp: string | number): string {
  return JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd: projectDir })
}

function userMessage(text: string): string {
  return JSON.stringify({
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: '2025-01-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
}

function assistantMessage(text: string): string {
  return JSON.stringify({
    type: 'message',
    id: 'm2',
    parentId: 'm1',
    timestamp: '2025-01-01T00:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

/** Write a FLAT session file at the sessions root (dscode hard-link view). */
function writeFlatSession(name: string, lines: string[]): string {
  const root = sessionsRoot(agentDir)
  mkdirSync(root, { recursive: true })
  const filePath = path.join(root, name)
  writeFileSync(filePath, lines.join('\n') + '\n')
  return filePath
}

/** Write a date-partitioned session file (dscode canonical storage view). */
function writePartitionedSession(date: string, name: string, lines: string[]): string {
  const [y, m, d] = date.split('-')
  const dir = path.join(sessionsRoot(agentDir), y, m, d)
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, name)
  writeFileSync(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('listSessionHistory', () => {
  it('returns [] when the sessions directory does not exist', async () => {
    expect(await listSessionHistory(projectDir, agentDir)).toEqual([])
  })

  it('lists flat sessions newest first with titles from the first user message', async () => {
    writeFlatSession('2025-01-01T00-00-00-000Z_uuid-a.jsonl', [
      sessionHeader('uuid-a', '2025-01-01T00:00:00.000Z'),
      userMessage('fix the login bug'),
      assistantMessage('looking into it')
    ])
    writeFlatSession('2025-01-03T00-00-00-000Z_uuid-b.jsonl', [
      sessionHeader('uuid-b', '2025-01-03T00:00:00.000Z'),
      userMessage('add dark mode')
    ])

    const list = await listSessionHistory(projectDir, agentDir)
    expect(list.map((s) => s.uuid)).toEqual(['uuid-b', 'uuid-a'])
    expect(list[0].title).toBe('add dark mode')
    expect(list[1].title).toBe('fix the login bug')
    expect(list[0].cwd).toBe(projectDir)
  })

  it('finds sessions in YYYY/MM/DD date partitions', async () => {
    writePartitionedSession('2025-01-02', '2025-01-02T00-00-00-000Z_uuid-p.jsonl', [
      sessionHeader('uuid-p', '2025-01-02T00:00:00.000Z'),
      userMessage('partitioned session')
    ])
    const list = await listSessionHistory(projectDir, agentDir)
    expect(list.map((s) => s.uuid)).toEqual(['uuid-p'])
    expect(list[0].title).toBe('partitioned session')
  })

  it('dedupes the flat hard-link and the date-partitioned copy by session id', async () => {
    writeFlatSession('2025-01-01T00-00-00-000Z_uuid-d.jsonl', [
      sessionHeader('uuid-d', '2025-01-01T00:00:00.000Z'),
      userMessage('one transcript, two paths')
    ])
    writePartitionedSession('2025-01-01', '2025-01-01T00-00-00-000Z_uuid-d.jsonl', [
      sessionHeader('uuid-d', '2025-01-01T00:00:00.000Z'),
      userMessage('one transcript, two paths')
    ])
    const list = await listSessionHistory(projectDir, agentDir)
    expect(list).toHaveLength(1)
    expect(list[0].uuid).toBe('uuid-d')
  })

  it('only returns sessions whose header cwd matches the project', async () => {
    writeFlatSession('2025-01-01T00-00-00-000Z_uuid-mine.jsonl', [
      sessionHeader('uuid-mine', '2025-01-01T00:00:00.000Z'),
      userMessage('my session')
    ])
    const other = mkdtempSync(path.join(tmpdir(), 'dscode-other-'))
    try {
      writeFlatSession('2025-01-01T00-00-00-000Z_uuid-theirs.jsonl', [
        JSON.stringify({ type: 'session', version: 3, id: 'uuid-theirs', timestamp: '2025-01-01T00:00:00.000Z', cwd: other }),
        userMessage('someone else session')
      ])
      const list = await listSessionHistory(projectDir, agentDir)
      expect(list.map((s) => s.uuid)).toEqual(['uuid-mine'])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('falls back to Untitled without a user message', async () => {
    writeFlatSession('2025-01-01T00-00-00-000Z_uuid-u.jsonl', [
      sessionHeader('uuid-u', '2025-01-01T00:00:00.000Z'),
      assistantMessage('I said something unprompted')
    ])
    const list = await listSessionHistory(projectDir, agentDir)
    expect(list[0].title).toBe('Untitled')
  })

  it('skips corrupt files and non-jsonl files', async () => {
    writeFlatSession('good_uuid-g.jsonl', [
      sessionHeader('uuid-g', '2025-01-01T00:00:00.000Z'),
      userMessage('good session')
    ])
    writeFlatSession('broken_uuid-x.jsonl', ['{not json', userMessage('unreachable')])
    writeFlatSession('README.txt', [sessionHeader('uuid-t', '2025-01-01T00:00:00.000Z')])

    const list = await listSessionHistory(projectDir, agentDir)
    expect(list.map((s) => s.uuid)).toEqual(['uuid-g'])
  })

  it('ignores files without a session header', async () => {
    writeFlatSession('stray_uuid-s.jsonl', [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [] } })
    ])
    expect(await listSessionHistory(projectDir, agentDir)).toEqual([])
  })
})

describe('isSessionFilePath / deleteSessionFile', () => {
  it('deletes a flat session file inside the sessions root', async () => {
    const filePath = writeFlatSession('del_uuid-d.jsonl', [
      sessionHeader('uuid-d', '2025-01-01T00:00:00.000Z')
    ])
    expect(isSessionFilePath(filePath, agentDir)).toBe(true)
    expect(await deleteSessionFile(filePath, agentDir)).toBe(true)
    expect(existsSync(filePath)).toBe(false)
  })

  it('deletes the hard-linked date-partition sibling along with the flat link', async () => {
    const flat = writeFlatSession('2025-01-01T00-00-00-000Z_uuid-h.jsonl', [
      sessionHeader('uuid-h', '2025-01-01T00:00:00.000Z')
    ])
    const dir = path.join(sessionsRoot(agentDir), '2025', '01', '01')
    mkdirSync(dir, { recursive: true })
    const partitioned = path.join(dir, '2025-01-01T00-00-00-000Z_uuid-h.jsonl')
    linkSync(flat, partitioned) // same inode — exactly dscode's layout

    expect(await deleteSessionFile(flat, agentDir)).toBe(true)
    expect(existsSync(flat)).toBe(false)
    expect(existsSync(partitioned)).toBe(false)
  })

  it('refuses paths outside the sessions root', async () => {
    const outside = path.join(projectDir, 'keep.jsonl')
    writeFileSync(outside, '{}')
    expect(isSessionFilePath(outside, agentDir)).toBe(false)
    expect(await deleteSessionFile(outside, agentDir)).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  it('refuses non-jsonl files inside the sessions root', async () => {
    const root = sessionsRoot(agentDir)
    mkdirSync(root, { recursive: true })
    const inside = path.join(root, 'notes.txt')
    writeFileSync(inside, 'x')
    expect(await deleteSessionFile(inside, agentDir)).toBe(false)
    expect(existsSync(inside)).toBe(true)
  })

  it('refuses traversal out of the root', async () => {
    const root = path.join(agentDir, 'sessions')
    mkdirSync(root, { recursive: true })
    const escape = path.join(root, '..', 'escape.jsonl')
    writeFileSync(path.join(agentDir, 'escape.jsonl'), '{}')
    expect(await deleteSessionFile(escape, agentDir)).toBe(false)
    expect(existsSync(path.join(agentDir, 'escape.jsonl'))).toBe(true)
  })

  it('returns false for a missing file inside the root', async () => {
    const ghost = path.join(agentDir, 'sessions', 'ghost.jsonl')
    expect(isSessionFilePath(ghost, agentDir)).toBe(true)
    expect(await deleteSessionFile(ghost, agentDir)).toBe(false)
  })

  it('refuses a session symlink whose target escapes the sessions root', () => {
    const root = sessionsRoot(agentDir)
    mkdirSync(root, { recursive: true })
    const outside = path.join(projectDir, 'outside.jsonl')
    writeFileSync(outside, '{"type":"session"}')
    const link = path.join(root, 'evil.jsonl')
    symlinkSync(outside, link)
    expect(isSessionFilePath(link, agentDir)).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })
})