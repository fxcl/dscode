import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createIsolatedOmpEnvironment,
  binaryAvailable,
  runOmp,
  IsolatedRuntime
} from './isolated-runtime'

/**
 * Package-management compatibility against the real dscode CLI — hermetic
 * (a local `file:` package; no network, no npm). Verifies the install →
 * settings → remove round-trip the GUI's Packages page rides on.
 */

const DSCODE_BIN =
  process.env.DSCODE_BIN || path.resolve(__dirname, '..', '..', '..', 'dist', 'cli.js')

describe('DSCode CLI — packages compat (file: source, isolated)', () => {
  let available = false
  beforeAll(() => {
    available = binaryAvailable(DSCODE_BIN)
    if (!available) {
      console.warn('[test:dscode] dscode binary not found — build the repo (pnpm build); skipping suite')
    }
  })

  it('install → configured → remove round-trip', async () => {
    if (!available) return
    // A minimal local pi package: manifest only, no resources.
    const pkgDir = mkdtempSync(path.join(tmpdir(), 'dscode-gui-pkg-'))
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'dscode-gui-it-pkg', version: '0.0.1', pi: {} }, null, 2)
    )
    const iso: IsolatedRuntime = createIsolatedOmpEnvironment()
    try {
      // dscode takes local packages as plain paths (a `file:` prefix is
      // treated as a relative path by the installer — verified live).
      const source = pkgDir

      const installOut = runOmp(iso.env, DSCODE_BIN, ['packages', 'install', source])
      expect(installOut).toMatch(/Installed/i)

      // The runtime's own settings must now carry the source.
      const settingsPath = path.join(iso.agentDir, 'settings.json')
      const settings = JSON.parse(
        (await import('node:fs')).readFileSync(settingsPath, 'utf-8') as string
      ) as { packages?: unknown[] }
      const listed = JSON.stringify(settings.packages ?? [])
      expect(listed).toContain(pkgDir.split(path.sep).pop()!)

      const removeOut = runOmp(iso.env, DSCODE_BIN, ['packages', 'remove', source])
      expect(removeOut).toMatch(/Removed/i)
    } finally {
      iso.cleanup()
      rmSync(pkgDir, { recursive: true, force: true })
    }
  })
})