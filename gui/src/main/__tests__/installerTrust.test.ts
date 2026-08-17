import { describe, it, expect } from 'vitest'
import { DSCODE_PACKAGE, minimalInstallerEnv, npmInvocation } from '../installer'

describe('installer trust boundary', () => {
  it('installs exactly the official dscode package', () => {
    expect(DSCODE_PACKAGE).toBe('@thinkany/dscode')
  })

  it('builds a fixed npm command line — no caller-controlled argv', () => {
    const { cmd, args, shell } = npmInvocation()
    expect(['npm', 'npm.cmd']).toContain(cmd)
    expect(args).toEqual(['install', '-g', DSCODE_PACKAGE])
    if (process.platform === 'win32') expect(shell).toBe(true)
  })

  it('passes a minimal environment — never provider credentials', () => {
    const env = minimalInstallerEnv()
    const keys = Object.keys(env)
    for (const key of keys) {
      expect(key).toMatch(/^(PATH|HOME|SHELL|TMPDIR|LANG|LC_ALL|TERM|USER|LOGNAME|NO_COLOR|FORCE_COLOR|NPM_CONFIG_USERCONFIG)$/)
    }
    expect(env.PATH).toBeTruthy()
  })

  it('forwards nothing beyond the allowlist even when the host env is rich', () => {
    const before = { ...process.env }
    process.env.DEEPSEEK_API_KEY = 'sk-secret'
    process.env.AWS_SECRET_ACCESS_KEY = 'topsecret'
    try {
      const env = minimalInstallerEnv()
      expect(env.DEEPSEEK_API_KEY).toBeUndefined()
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    } finally {
      process.env = before
    }
  })
})
