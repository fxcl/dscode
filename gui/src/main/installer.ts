import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InstallStatus } from '../shared/types'

/**
 * DSCode auto-install: `npm install -g @thinkany/dscode`.
 *
 * Unlike the omp.sh curl-pipe-sh installer this rides npm's own registry
 * transport (integrity + TLS), so there is no download trust boundary to
 * re-implement here. The command line is a fixed constant — nothing from the
 * renderer ever reaches the spawned process's argv.
 */

/** The exact package the installer may touch. */
export const DSCODE_PACKAGE = '@thinkany/dscode'

/** Environment passed to npm: minimal, no credentials. */
const INSTALLER_ENV_KEYS = [
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'LOGNAME',
  'NO_COLOR',
  'FORCE_COLOR'
]

/** Build a minimal child env — never forward provider keys / tokens / AWS_* etc. */
export function minimalInstallerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of INSTALLER_ENV_KEYS) {
    if (process.env[key] !== undefined) out[key] = process.env[key]
  }
  out.PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:' + (process.env.PATH || '')
  return out
}

/** npm executable per platform (npm.cmd needs a shell on Windows). */
export function npmInvocation(): { cmd: string; args: string[]; shell: boolean } {
  const args = ['install', '-g', DSCODE_PACKAGE]
  return process.platform === 'win32'
    ? { cmd: 'npm.cmd', args, shell: true }
    : { cmd: 'npm', args, shell: false }
}

export async function installDSCode(
  onStatus: (status: InstallStatus) => void
): Promise<boolean> {
  const npmHome = attemptNpmHome()

  onStatus({ type: 'installing', message: `Installing ${DSCODE_PACKAGE} with npm (may require a moment)...` })

  const { cmd, args, shell } = npmInvocation()
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...minimalInstallerEnv(), ...(npmHome ? { NPM_CONFIG_USERCONFIG: npmHome } : {}) },
      shell
    })

    let output = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      output += text
      const lastLine = text.trim().split('\n').pop() || ''
      onStatus({ type: 'installing', message: lastLine || 'Installing...' })
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      output += text
      const lastLine = text.trim().split('\n').pop() || ''
      onStatus({ type: 'installing', message: lastLine || 'Installing...' })
    })

    proc.on('error', (err) => {
      onStatus({
        type: 'error',
        message: `npm is required for auto-install (${err.message}). Install Node.js from https://nodejs.org, then run: npm install -g ${DSCODE_PACKAGE}`
      })
      resolve(false)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        onStatus({ type: 'success' })
        resolve(true)
      } else {
        onStatus({
          type: 'error',
          message: `Install failed with code ${code}.\n${output.slice(-500)}`
        })
        resolve(false)
      }
    })
  })
}

/**
 * npm refuses to run as root without a userconfig. GUI apps are rarely root,
 * but when they are (rare Linux setups) point npm at a writable config so the
 * install does not die immediately.
 */
function attemptNpmHome(): string | null {
  if (process.getuid?.() !== 0) return null
  const dir = path.join(os.tmpdir(), 'dscode-gui-npm')
  try {
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'npmrc')
  } catch {
    return null
  }
}
