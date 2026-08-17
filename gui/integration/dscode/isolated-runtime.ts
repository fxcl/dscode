import { execFileSync, spawn, ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Isolated runtime environment for integration tests. Every test that touches
 * `--config`, session state, auth, or the agent directory gets a fresh temp
 * root; the developer's real `~/.dscode` (and `~/.omp`), auth, config and
 * credentials are NEVER inherited. This is the non-negotiable safety boundary
 * of `pnpm test:dscode` (see README + docs/settings-auth.md).
 *
 * Relocation uses the official mechanisms: `DSCODE_HOME` for dscode (dscode
 * itself sets PI_CODING_AGENT_DIR from it) and `PI_CODING_AGENT_DIR` for
 * omp/pi — never guessed internal directory layouts.
 */

export interface IsolatedRuntime {
  /** Temp root (delete with cleanup()). */
  root: string
  /** Isolated agent dir (DSCODE_HOME / PI_CODING_AGENT_DIR). */
  agentDir: string
  /** Isolated HOME (so ~/.dscode and ~/.omp can never be the real ones). */
  homeDir: string
  /** Environment for spawning dscode/omp/pi — credential-stripped, isolated. */
  env: NodeJS.ProcessEnv
  /** Path to the dscode binary (DSCODE_BIN override, else the repo's dist/cli.js). */
  dscodeBin: string
  /** Path to the omp binary unless overridden via OMP_BIN. */
  ompBin: string
  /** Path to the pi binary unless overridden via PI_BIN (may not exist). */
  piBin: string
  /** Remove the whole temp root. Safe to call multiple times. */
  cleanup: () => void
  /** Open a long-running RPC process (stdio pipes) wired to the isolated env. */
  spawnRpc: (bin: string, extraArgs?: string[]) => ChildProcess
}

/** Credential-matching prefixes stripped from the isolated environment. */
const CREDENTIAL_ENV_RE =
  /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|GROQ|CEREBRAS|XAI|OPENROUTER|KILO|MISTRAL|ZAI|MINIMAX|OPENCODE|AI_GATEWAY|AZURE|AWS|TAVILY|BRAVE|PERPLEXITY|EXA|FIRECRAWL|TINYFISH|WAIFER|UMANS|UMANS_AI|DEEPSEEK|DSCODE)_?/i

/**
 * Shape-based fallback: anything that *looks* like a secret (API_KEY /
 * TOKEN / SECRET / PASSWORD suffix) is stripped too, so credentials from
 * provider families the prefix list doesn't know yet can never leak into
 * the isolated child.
 */
const CREDENTIAL_SHAPE_RE = /(API_KEY|_TOKEN|_SECRET|_PASSWORD|PASSWD)$/i

export function stripCredentials(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(input)) {
    if (CREDENTIAL_ENV_RE.test(key)) continue
    if (CREDENTIAL_SHAPE_RE.test(key)) continue
    if (key === 'DSCODE_GUI_RUN_LIVE_TESTS' || key === 'OMP_GUI_RUN_LIVE_TESTS') continue
    out[key] = value
  }
  return out
}

/**
 * Build an isolated runtime environment. Each call returns a NEW directory,
 * so parallel suites (if any) can never share state. `credentials: false`
 * (default) removes every provider key even when the real HOME has one.
 */
export function createIsolatedOmpEnvironment(opts: { credentials?: boolean } = {}): IsolatedRuntime {
  const root = mkdtempSync(path.join(tmpdir(), 'dscode-gui-it-'))
  const agentDir = path.join(root, 'agent')
  const homeDir = path.join(root, 'home')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })

  // The dscode checkout this GUI lives in: <repo>/dist/cli.js (built via
  // `pnpm build` in the repo root). DSCODE_BIN overrides for installed CLIs.
  const repoCli = path.resolve(__dirname, '..', '..', '..', 'dist', 'cli.js')
  const dscodeBin = process.env.DSCODE_BIN || repoCli
  const ompBin = process.env.OMP_BIN || 'omp'
  const piBin = process.env.PI_BIN || 'pi'

  const base = opts.credentials === true ? { ...process.env } : stripCredentials(process.env)
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: homeDir,
    DSCODE_HOME: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    FORCE_COLOR: '0',
    NO_COLOR: '1'
  }

  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // already gone — fine
    }
  }

  const spawnRpc = (bin: string, extraArgs: string[] = []): ChildProcess =>
    spawn(bin, ['--mode', 'rpc', ...extraArgs], {
      cwd: agentDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

  return { root, agentDir, homeDir, env, dscodeBin, ompBin, piBin, cleanup, spawnRpc }
}

/**
 * Run `<bin> <args>` synchronously in the isolated env. Returns the combined
 * stdout+stderr WITHOUT throwing on non-zero exit (we assert on the error
 * text itself, e.g. "Unknown setting" / "Invalid value").
 */
export function runOmp(env: NodeJS.ProcessEnv, bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { env, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string }
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
}

/** True when `<bin> --version` reports a usable binary. */
export function binaryAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { timeout: 10_000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Fail fast when `OMP_REQUIRED=1` is set and the binary is absent. This turns
 * the optional local smoke test into a hard release-compatibility gate in CI.
 */
export function requireBinary(bin: string): void {
  if (!binaryAvailable(bin)) {
    const message = `Required OMP binary '${bin}' not found (OMP_REQUIRED=1)`
    if (process.env.OMP_REQUIRED === '1') {
      throw new Error(message)
    }
    console.warn(`[test:omp] ${message.split('(')[0].trim()} — skipping suite`)
  }
}

/** Assert that the isolated env did not touch the real user agent dir. */
export function realAgentDirAbsent(iso: IsolatedRuntime): void {
  // The real agent dir is the process's own HOME/.dscode (or ~/.omp/agent);
  // the isolated env must never equal either.
  const home = process.env.HOME ?? ''
  if (iso.agentDir === path.join(home, '.dscode')) {
    throw new Error('isolated agent dir escaped to the real HOME')
  }
  if (iso.agentDir === path.join(home, '.omp', 'agent')) {
    throw new Error('isolated agent dir escaped to the real OMP HOME')
  }
}